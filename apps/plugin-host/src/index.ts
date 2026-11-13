import { join } from "node:path";
import { createLogger, loadConfig } from "@bulletin/config";
import { startService } from "@bulletin/config/server";
import { Broker } from "./broker/broker.ts";
import { BrokerChannel } from "./broker/channel.ts";
import { PluginDatabase } from "./broker/database.ts";
import { EgressProxy } from "./broker/egress.ts";
import { loadPluginManifest, loadPluginMigrations } from "./broker/manifest.ts";
import { loadPluginHostConfig } from "./config.ts";
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
const database = await PluginDatabase.open({
  adminUrl: config.databaseUrl,
  pluginId: manifest.id,
  migrations,
  logger,
});
const egress = new EgressProxy({
  allowedHosts: manifest.egressHosts,
  logger: logger.child({ component: "egress" }),
});
const broker = new Broker({ database, egress, logger });
const channel = new BrokerChannel({
  socketPath: join(sandboxConfig.stateDir, "broker.sock"),
  logger,
  handler: broker,
});
await channel.start();

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
});

await startService({
  service: "plugin-host",
  logger,
  port: config.port,
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/sandbox") {
      return Response.json(supervisor.status());
    }

    if (url.pathname === "/broker") {
      return Response.json({ schema: database.schema, stats: broker.stats() });
    }

    return Response.json({ service: "plugin-host", status: "ok" });
  },
  checks: [
    { name: "sandbox", check: () => supervisor.ready },
    { name: "broker", check: () => broker.ready },
  ],
  async onShutdown() {
    await supervisor.stop();
    await channel.close();
    await broker.close();
  },
});

logger.info("service listening", { port: config.port });

void supervisor.start().catch((error: unknown) => {
  logger.error("sandbox.start_failed", { error });
});
