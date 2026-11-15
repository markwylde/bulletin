import { bumpCacheTags } from "@bulletin/cache";
import {
  connectionPoolSize,
  createLogger,
  loadConfig,
  loadStorageEnvironment,
  metrics,
  metricsPortFromEnv,
  standardMetrics,
} from "@bulletin/config";
import { listenSqlFromEnv, startService } from "@bulletin/config/server";
import { initTracing } from "@bulletin/config/tracing";
import {
  can,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import {
  advancePluginsGeneration,
  PLUGINS_NOTIFY_CHANNEL,
  PluginCircuitBreaker,
} from "@bulletin/domain/plugins";
import type { PluginManifest } from "@bulletin/plugin-sdk/manifest";
import { createStorage } from "@bulletin/storage";
import { SQL } from "bun";
import type { PluginGrants } from "./broker/broker.ts";
import { CacheInvalidator } from "./broker/cache.ts";
import type { BrokerChannel } from "./broker/channel.ts";
import { PluginConnectionManager } from "./broker/connections.ts";
import { CoreApiClient } from "./broker/core.ts";
import { loadPluginHostConfig } from "./config.ts";
import { readInternal, serveClientApp } from "./hooks/http.ts";
import { PluginHookRegistry } from "./hooks/registry.ts";
import { PluginHookRunner } from "./hooks/runner.ts";
import { usesSharedPluginCluster } from "./quota/monitor.ts";
import { PluginManager, type RunningPlugin } from "./runtime/manager.ts";
import { runSandboxPreflight } from "./sandbox/preflight.ts";
import { buildSeccompPolicy, sandboxArch } from "./sandbox/seccomp.ts";
import { SandboxSupervisor } from "./sandbox/supervisor.ts";

const config = loadConfig();
const sandboxConfig = loadPluginHostConfig(Bun.env);
const logger = createLogger({ service: "plugin-host", level: config.logLevel });
initTracing({ service: "plugin-host" });

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

const pluginDatabaseUrl = sandboxConfig.pluginDatabaseUrl ?? config.databaseUrl;
const connections = new PluginConnectionManager({
  adminUrl: pluginDatabaseUrl,
  maxConnections: connectionPoolSize("plugin-host"),
});
// Broker pool saturation (ADR 0020): lazily-opened plugin connections against the semaphore.
metrics.addCollector(() => {
  const stats = connections.stats();
  standardMetrics.dbPoolConnections.replace([
    [{ state: "active" }, stats.open],
    [{ state: "waiting" }, stats.waiting],
  ]);
  standardMetrics.dbPoolMax.set({}, stats.maxConnections);
});
const core = new CoreApiClient({
  baseUrl: sandboxConfig.coreApiUrl,
  token: sandboxConfig.coreBrokerToken,
});
const cacheSql = new SQL(config.databaseUrl, { max: 1, connectionTimeout: 5 });
// The plugin manager's control connection: fragment publishing holds a transaction, so it
// must not share the single cache/permission connection.
const controlSql = new SQL(config.databaseUrl, { max: 2, connectionTimeout: 5 });
const cache = new CacheInvalidator({
  bump: async (tags) => {
    await bumpCacheTags(cacheSql, tags);
  },
  logger: logger.child({ component: "cache" }),
});
const pluginActive = async (pluginId: string): Promise<boolean> => {
  const rows = (await cacheSql`
    SELECT p.enabled, p.state, f.default_value
    FROM core.plugins p
    LEFT JOIN core.feature_flags f ON f.key = 'plugins'
    WHERE p.plugin_id = ${pluginId}
  `) as Array<{ enabled: boolean; state: string; default_value: boolean | null }>;
  const row = rows[0];
  return !!row?.enabled && row.state === "active" && row.default_value !== false;
};

const pluginGrants = async (pluginId: string): Promise<PluginGrants | null> => {
  const rows = (await cacheSql`
    SELECT approved_capabilities, approved_egress_hosts
    FROM core.plugins WHERE plugin_id = ${pluginId}
  `) as Array<{ approved_capabilities: unknown; approved_egress_hosts: unknown }>;
  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

  return {
    capabilities: strings(row.approved_capabilities),
    egressHosts: strings(row.approved_egress_hosts),
  };
};

const hooks = new PluginHookRegistry();
const transports = new Map<string, BrokerChannel>();
const bundles = new Map<string, { manifest: PluginManifest; path: string }>();
const seccompPolicy = buildSeccompPolicy(sandboxArch(process.arch));
const marketplaceUrl = Bun.env.BULLETIN_MARKETPLACE_URL?.trim();

const plugins = new PluginManager({
  sql: controlSql,
  logger,
  stateDir: sandboxConfig.stateDir,
  pluginDatabaseUrl,
  connections,
  core,
  cache,
  nodeEnv: config.nodeEnv,
  isActive: pluginActive,
  grants: pluginGrants,
  hooks,
  transports,
  bundles,
  quota: {
    quotaBytes: sandboxConfig.storageQuotaBytes,
    intervalMs: sandboxConfig.quotaIntervalMs,
  },
  localBundlePath: sandboxConfig.bundlePath,
  storage: createStorage(loadStorageEnvironment(Bun.env, config.nodeEnv)),
  ...(marketplaceUrl === undefined || marketplaceUrl === "" ? {} : { marketplaceUrl }),
  createSupervisor: ({ pluginId, bundlePath, channel, maintenance }) =>
    new SandboxSupervisor({
      pluginId,
      bundlePath,
      socketPath: channel.socketPath,
      nsjailPath: sandboxConfig.nsjailPath,
      rootfsPath: sandboxConfig.rootfsPath,
      cgroupV2Mount: cgroupRoot,
      seccompPolicy,
      limits: sandboxConfig.limits,
      channel,
      logger,
      readyTimeoutMs: sandboxConfig.readyTimeoutMs,
      ...(maintenance ? { maxLifetimeMs: 60_000 } : { restart: sandboxConfig.restart }),
    }),
});

const canReadContent = async (pluginId: string, forumId: string): Promise<boolean> => {
  const rows = (await cacheSql`
      SELECT enabled, state, service_principal_group, elevated_grants
      FROM core.plugins WHERE plugin_id = ${pluginId}
    `) as Array<{
    enabled: boolean;
    state: string;
    service_principal_group: string;
    elevated_grants: unknown;
  }>;
  const plugin = rows[0];

  if (plugin === undefined || !plugin.enabled || plugin.state !== "active") {
    return false;
  }

  const grants = Array.isArray(plugin.elevated_grants)
    ? plugin.elevated_grants
        .map((entry) =>
          typeof entry === "object" && entry !== null
            ? String((entry as { forumId?: unknown }).forumId ?? "")
            : "",
        )
        .filter((id) => id !== "")
    : [];

  if (grants.includes(forumId)) {
    return true;
  }

  const tree = await loadForumTree(cacheSql);
  const snapshot = await loadPermissionSnapshot(cacheSql, GUEST_PRINCIPAL, { tree });
  return can(cacheSql, GUEST_PRINCIPAL, "read", { forumId, tree, snapshot });
};

const breaker = new PluginCircuitBreaker({
  sql: cacheSql,
  disable: async (pluginId, reason) => {
    await cacheSql`
      UPDATE core.plugins SET state = 'disabled', enabled = false, updated_at = now()
      WHERE plugin_id = ${pluginId}
    `;
    await cacheSql`
      DELETE FROM core.hook_fragments
      WHERE plugin_id = ${pluginId}
        AND generation = (SELECT generation FROM core.plugin_generation WHERE id = true)
    `;
    await advancePluginsGeneration(cacheSql);
    standardMetrics.pluginBreakerTrips.inc({ plugin: pluginId });
    logger.error("plugin.auto_disabled", { pluginId, reason });
    void plugins.reconcile();
  },
});
const hookRunner = new PluginHookRunner({
  transportFor: (pluginId) => transports.get(pluginId),
  registry: hooks,
  logger: logger.child({ component: "hooks" }),
  isActive: pluginActive,
  onFailure: (pluginId, hook, error) => {
    void breaker.recordFailure(pluginId, hook, error);
  },
  onSuccess: (pluginId, hook) => {
    void breaker.recordSuccess(pluginId, hook);
  },
  canReadContent,
});

const hookHttp = {
  runner: hookRunner,
  registry: hooks,
  transports,
  canReadContent,
  isPluginActive: pluginActive,
  maintenanceGdpr: (pluginId: string, operation: "export" | "erase", memberId: string) =>
    plugins.maintenanceGdpr(pluginId, operation, memberId),
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

async function initPlugins(attempt = 0): Promise<void> {
  try {
    await plugins.init();
  } catch (error) {
    // Postgres may still be migrating on a fresh stack; keep trying, the health check stays red.
    if (attempt % 15 === 14) {
      logger.error("plugin.init_retrying", { attempt: attempt + 1, error });
    }

    setTimeout(() => {
      void initPlugins(attempt + 1);
    }, 2_000).unref?.();
    return;
  }

  await plugins.reconcile();
}

// Installs, enables, disables and uninstalls arrive as a NOTIFY wake-up; the durable request is
// the `core.plugins` row, re-read on every pass and on the periodic sweep (ADR 0003).
const listenSql = listenSqlFromEnv(new SQL(config.databaseUrl, { max: 1, connectionTimeout: 5 }));
const pluginSubscription = await listenSql.listen(
  PLUGINS_NOTIFY_CHANNEL,
  () => {
    void plugins.reconcile();
  },
  () => {
    void plugins.reconcile();
  },
);
const sweep = setInterval(() => {
  void plugins.reconcile();
}, sandboxConfig.reconcileIntervalMs);
sweep.unref?.();

function localPlugin(): RunningPlugin | undefined {
  const id = plugins.localPluginId;
  return id === undefined ? undefined : plugins.get(id);
}

await startService({
  service: "plugin-host",
  metricsPort: metricsPortFromEnv(),
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

    // Status for one plugin (`?plugin=<id>`, default the local demo plugin) or all of them.
    const selected = url.searchParams.get("plugin");
    const plugin = selected === null ? localPlugin() : plugins.get(selected);

    if (url.pathname === "/plugins") {
      return Response.json({
        plugins: [...plugins.running()].map(([id, running]) => ({
          id,
          version: running.manifest.version,
          sandbox: running.supervisor.status(),
        })),
      });
    }

    if (url.pathname === "/sandbox") {
      return plugin === undefined
        ? Response.json({ code: "not_running" }, { status: 404 })
        : Response.json(plugin.supervisor.status());
    }

    if (url.pathname === "/broker") {
      return plugin === undefined
        ? Response.json({ code: "not_running" }, { status: 404 })
        : Response.json({
            schema: plugin.database.schema,
            stats: plugin.broker.stats(),
            connections: connections.stats(),
          });
    }

    if (url.pathname === "/quota") {
      return plugin === undefined
        ? Response.json({ code: "not_running" }, { status: 404 })
        : Response.json({ ...plugin.quota.status(), sharedCluster });
    }

    return Response.json({ service: "plugin-host", status: "ok" });
  },
  // The local demo plugin is the readiness probe for the jail itself; installed plugins
  // report their own state in `core.plugins` and must not take the host down.
  checks: [
    { name: "sandbox", check: () => localPlugin()?.supervisor.ready ?? false },
    { name: "broker", check: () => localPlugin()?.broker.ready ?? false },
  ],
  async onShutdown() {
    clearInterval(sweep);
    await pluginSubscription.unlisten().catch(() => undefined);
    await plugins.close();
    await cache.flush();
    await cacheSql.close().catch(() => undefined);
    await controlSql.close().catch(() => undefined);
    await connections.close();
  },
});

logger.info("service listening", { port: config.port });

void initPlugins();
