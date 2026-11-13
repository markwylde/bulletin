import { join } from "node:path";
import { bumpCacheTags } from "@bulletin/cache";
import { connectionPoolSize, createLogger, loadConfig } from "@bulletin/config";
import { startService } from "@bulletin/config/server";
import { SQL } from "bun";
import { Broker } from "./broker/broker.ts";
import { CacheInvalidator } from "./broker/cache.ts";
import { BrokerChannel } from "./broker/channel.ts";
import { PluginConnectionManager } from "./broker/connections.ts";
import { CoreApiClient } from "./broker/core.ts";
import { PluginDatabase } from "./broker/database.ts";
import { EgressProxy } from "./broker/egress.ts";
import { loadPluginManifest, loadPluginMigrations } from "./broker/manifest.ts";
import { loadPluginHostConfig } from "./config.ts";
import { readInternal, serveClientApp } from "./hooks/http.ts";
import { publishPluginFragments, publishPluginRegistry } from "./hooks/publish.ts";
import { PluginHookRegistry } from "./hooks/registry.ts";
import { PluginHookRunner } from "./hooks/runner.ts";
import { PluginQuotaMonitor, usesSharedPluginCluster } from "./quota/monitor.ts";
import { runSandboxPreflight } from "./sandbox/preflight.ts";
import { buildSeccompPolicy, sandboxArch } from "./sandbox/seccomp.ts";
import { SandboxSupervisor } from "./sandbox/supervisor.ts";

const config = loadConfig();
const sandboxConfig = loadPluginHostConfig(Bun.env);
const logger = createLogger({ service: "plugin-host", level: config.logLevel });

let cgroupRoot: string;

try {
  // Fail closed: a plugin-host without its jail capabilities, outer seccomp profile or
  // writable cgroup hierarchy must not run plugin code with weaker isolation. Run this
  // before provisioning the plugin so a misconfigured host changes nothing.
  const preflight = await runSandboxPreflight({
    nsjailPath: sandboxConfig.nsjailPath,
    rootfsPath: sandboxConfig.rootfsPath,
    cgroupV2Mount: sandboxConfig.cgroupV2Mount,
  });
  cgroupRoot = preflight.cgroupRoot;
  logger.info("sandbox.preflight_ok", { cgroupRoot });
} catch (error) {
  logger.error("sandbox.preflight_failed", { error });
  throw error;
}

const manifest = await loadPluginManifest(sandboxConfig.bundlePath);
const migrations = await loadPluginMigrations(sandboxConfig.bundlePath, manifest);
const connections = new PluginConnectionManager({
  adminUrl: config.databaseUrl,
  maxOpenPlugins: connectionPoolSize("plugin-host"),
});
const database = await PluginDatabase.open({
  adminUrl: config.databaseUrl,
  pluginId: manifest.id,
  migrations,
  logger,
  connections,
});
const egress = new EgressProxy({
  allowedHosts: manifest.egressHosts,
  logger: logger.child({ component: "egress" }),
});
const core = new CoreApiClient({
  baseUrl: sandboxConfig.coreApiUrl,
  token: sandboxConfig.coreBrokerToken,
});
const cacheSql = new SQL(config.databaseUrl, { max: 1, connectionTimeout: 5 });
const cache = new CacheInvalidator({
  bump: async (tags) => {
    await bumpCacheTags(cacheSql, tags);
  },
  logger: logger.child({ component: "cache" }),
});
const broker = new Broker({ database, egress, core, cache, logger });
const hooks = new PluginHookRegistry();
hooks.install(manifest, { generation: 1 });
const bundles = new Map([[manifest.id, { manifest, path: sandboxConfig.bundlePath }]]);
const channel = new BrokerChannel({
  socketPath: join(sandboxConfig.stateDir, "broker.sock"),
  logger,
  handler: broker,
});
await channel.start();

const hookRunner = new PluginHookRunner({
  transport: channel,
  registry: hooks,
  logger: logger.child({ component: "hooks" }),
});
const hookHttp = {
  runner: hookRunner,
  registry: hooks,
  transport: channel,
  token: sandboxConfig.internalToken,
  frameAncestors: [config.userOrigin, config.staffOrigin],
  logger: logger.child({ component: "hooks" }),
  bundles,
};

const sharedCluster = usesSharedPluginCluster({
  nodeEnv: config.nodeEnv,
  ...(sandboxConfig.pluginDatabaseUrl === undefined
    ? {}
    : { pluginDatabaseUrl: sandboxConfig.pluginDatabaseUrl }),
});

if (sharedCluster) {
  logger.error("plugin.shared_cluster_warning", {
    reason:
      "untrusted plugin schemas share the core Postgres cluster in production; set " +
      "PLUGIN_DATABASE_URL to a separate cluster for hard availability isolation",
  });
}

const quota = new PluginQuotaMonitor({
  adminUrl: config.databaseUrl,
  pluginId: manifest.id,
  logger: logger.child({ component: "quota" }),
  quotaBytes: sandboxConfig.storageQuotaBytes,
  intervalMs: sandboxConfig.quotaIntervalMs,
});
quota.start();

async function publishFragments(attempt = 0): Promise<void> {
  const sql = new SQL(config.databaseUrl, { max: 1, connectionTimeout: 5 });

  try {
    await publishPluginFragments(sql, manifest, logger);
    await publishPluginRegistry(sql, manifest, logger);
  } catch (error) {
    if (attempt < 30) {
      setTimeout(() => {
        void publishFragments(attempt + 1);
      }, 2_000).unref?.();
      return;
    }

    logger.error("plugin.fragments_publish_failed", { error });
  } finally {
    await sql.close().catch(() => undefined);
  }
}

void publishFragments();

const supervisor = new SandboxSupervisor({
  pluginId: manifest.id,
  bundlePath: sandboxConfig.bundlePath,
  socketPath: channel.socketPath,
  nsjailPath: sandboxConfig.nsjailPath,
  rootfsPath: sandboxConfig.rootfsPath,
  cgroupV2Mount: cgroupRoot,
  seccompPolicy: buildSeccompPolicy(sandboxArch(process.arch)),
  limits: sandboxConfig.limits,
  channel,
  logger,
  readyTimeoutMs: sandboxConfig.readyTimeoutMs,
  restart: sandboxConfig.restart,
});

await startService({
  service: "plugin-host",
  logger,
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    const internal = await readInternal(request, hookHttp);

    if (internal !== undefined) {
      return internal;
    }

    const app = await serveClientApp(url, bundles, hookHttp.frameAncestors);

    if (app !== undefined) {
      return app;
    }

    if (url.pathname === "/sandbox") {
      return Response.json(supervisor.status());
    }

    if (url.pathname === "/broker") {
      return Response.json({
        schema: database.schema,
        stats: broker.stats(),
        connections: connections.stats(),
      });
    }

    if (url.pathname === "/quota") {
      return Response.json({ ...quota.status(), sharedCluster });
    }

    return Response.json({ service: "plugin-host", status: "ok" });
  },
  checks: [
    { name: "sandbox", check: () => supervisor.ready },
    { name: "broker", check: () => broker.ready },
  ],
  async onShutdown() {
    quota.stop();
    await supervisor.stop();
    await channel.close();
    await broker.close();
    await cache.flush();
    await cacheSql.close().catch(() => undefined);
    await connections.close();
  },
});

logger.info("service listening", { port: config.port });

void supervisor.start().catch((error: unknown) => {
  logger.error("sandbox.start_failed", { error });
});
