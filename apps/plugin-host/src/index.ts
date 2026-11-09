import { join } from "node:path";
import { createLogger, loadConfig } from "@bulletin/config";
import { startService } from "@bulletin/config/server";
import { loadPluginHostConfig } from "./config.ts";
import { resolveSandboxCgroupRoot } from "./sandbox/cgroup.ts";
import { BrokerChannel } from "./sandbox/channel.ts";
import { buildSeccompPolicy, sandboxArch } from "./sandbox/seccomp.ts";
import { SandboxSupervisor } from "./sandbox/supervisor.ts";

const config = loadConfig();
const sandboxConfig = loadPluginHostConfig(Bun.env);
const logger = createLogger({ service: "plugin-host", level: config.logLevel });

const channel = new BrokerChannel({
  socketPath: join(sandboxConfig.stateDir, "broker.sock"),
  logger,
});
await channel.start();

let cgroupRoot = sandboxConfig.cgroupV2Mount;

try {
  cgroupRoot = await resolveSandboxCgroupRoot(sandboxConfig.cgroupV2Mount);
  logger.info("sandbox.cgroup_root", { path: cgroupRoot });
} catch (error) {
  logger.error("sandbox.cgroup_unavailable", { error });
}

const supervisor = new SandboxSupervisor({
  pluginId: sandboxConfig.pluginId,
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

    return Response.json({ service: "plugin-host", status: "ok" });
  },
  checks: [{ name: "sandbox", check: () => supervisor.ready }],
  async onShutdown() {
    await supervisor.stop();
    await channel.close();
  },
});

logger.info("service listening", { port: config.port });

void supervisor.start().catch((error: unknown) => {
  logger.error("sandbox.start_failed", { error });
});
