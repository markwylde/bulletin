import { join } from "node:path";
import { createLogger } from "@bulletin/config";
import { loadPluginHostConfig } from "../config.ts";
import { resolveSandboxCgroupRoot } from "../sandbox/cgroup.ts";
import { BrokerChannel } from "../sandbox/channel.ts";
import { readProcessTreeRssBytes, readProcFile, readSandboxCgroup } from "../sandbox/procfs.ts";
import { buildSeccompPolicy, sandboxArch } from "../sandbox/seccomp.ts";
import { SandboxSupervisor } from "../sandbox/supervisor.ts";
import type { SandboxCgroupUsage } from "../sandbox/types.ts";

/**
 * Spike S2 measurement: spawn and stop the demo sandbox N times and report the handshake
 * latency and the memory held by each cgroup. One untimed warm-up sandbox runs first so the
 * shared Bun binary is already in the page cache; per-sandbox marginal memory is the number
 * that matters once the host is warm.
 *
 * Run it inside the plugin-host container:
 *
 *   docker compose exec -T plugin-host bun apps/plugin-host/src/spike/measure.ts
 */

interface Sample {
  readonly iteration: number;
  readonly childPid: number | null;
  readonly spawnMs: number;
  readonly handshakeMs: number | null;
  readonly processTreeRssBytes: number | null;
  readonly memoryCurrentBytes: number | null;
  readonly anonBytes: number | null;
  readonly fileBytes: number | null;
  readonly memoryMaxBytes: number | null;
  readonly pidsMax: number | null;
  readonly cpuMax: string | null;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function numbers(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

async function detectEngine(): Promise<string> {
  const override = Bun.env.PLUGIN_HOST_ENGINE?.trim();

  if (override !== undefined && override !== "") {
    return override;
  }

  const cgroup = (await readProcFile("/proc/self/cgroup")) ?? "";

  if (cgroup.includes("libpod")) {
    return "podman";
  }

  if (cgroup.includes("docker")) {
    return "docker";
  }

  return "unknown";
}

function parseIterations(): number {
  const raw = Bun.env.PLUGIN_HOST_MEASURE_ITERATIONS?.trim() ?? "5";

  if (!/^\d+$/.test(raw)) {
    throw new Error("PLUGIN_HOST_MEASURE_ITERATIONS must be a positive integer");
  }

  const value = Number(raw);

  if (value < 1 || value > 50) {
    throw new Error("PLUGIN_HOST_MEASURE_ITERATIONS must be between 1 and 50");
  }

  return value;
}

const config = loadPluginHostConfig(Bun.env);
const logger = createLogger({ service: "plugin-host-measure", level: "error" });
const iterations = parseIterations();
const engine = await detectEngine();
const cgroupRoot = await resolveSandboxCgroupRoot(config.cgroupV2Mount);
const channel = new BrokerChannel({
  socketPath: join(config.stateDir, "measure-broker.sock"),
  logger,
});

function createSupervisor(): SandboxSupervisor {
  return new SandboxSupervisor({
    pluginId: config.pluginId,
    bundlePath: config.bundlePath,
    socketPath: channel.socketPath,
    nsjailPath: config.nsjailPath,
    rootfsPath: config.rootfsPath,
    cgroupV2Mount: cgroupRoot,
    seccompPolicy: buildSeccompPolicy(sandboxArch(process.arch)),
    limits: config.limits,
    channel,
    logger,
    readyTimeoutMs: config.readyTimeoutMs,
  });
}

async function runSandbox(iteration: number): Promise<Sample> {
  const supervisor = createSupervisor();
  const startedAt = performance.now();
  const status = await supervisor.start();
  const spawnMs = performance.now() - startedAt;

  // Let the runtime finish its first allocations before sampling memory.
  await Bun.sleep(250);

  const cgroup: SandboxCgroupUsage | undefined =
    status.childPid === null ? undefined : await readSandboxCgroup(cgroupRoot, status.childPid);
  const rss = status.pid === null ? null : await readProcessTreeRssBytes(status.pid);

  const sample: Sample = {
    iteration,
    childPid: status.childPid,
    spawnMs,
    handshakeMs: status.startupMs,
    processTreeRssBytes: rss,
    memoryCurrentBytes: cgroup?.memoryCurrentBytes ?? null,
    anonBytes: cgroup?.anonBytes ?? null,
    fileBytes: cgroup?.fileBytes ?? null,
    memoryMaxBytes: cgroup?.memoryMaxBytes ?? null,
    pidsMax: cgroup?.pidsMax ?? null,
    cpuMax: cgroup?.cpuMax ?? null,
  };

  await supervisor.stop();
  return sample;
}

await channel.start();

const samples: Sample[] = [];

try {
  // Warm-up: charge the shared Bun binary and loader pages to a throwaway sandbox.
  await runSandbox(0);

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    samples.push(await runSandbox(iteration));
  }
} finally {
  await channel.close();
}

const spawnTimes = samples.map((sample) => sample.spawnMs);
const memoryCurrent = numbers(samples.map((sample) => sample.memoryCurrentBytes));
const anon = numbers(samples.map((sample) => sample.anonBytes));
const limitsApplied = samples.every(
  (sample) =>
    sample.memoryMaxBytes === config.limits.memoryBytes &&
    sample.pidsMax === config.limits.pids &&
    sample.cpuMax === `${config.limits.cpuMsPerSecond * 1000} 1000000`,
);

const report = {
  engine,
  arch: process.arch,
  bun: Bun.version,
  iterations,
  spawnMs: {
    min: Math.round(percentile(spawnTimes, 0)),
    median: Math.round(percentile(spawnTimes, 0.5)),
    p95: Math.round(percentile(spawnTimes, 0.95)),
    max: Math.round(percentile(spawnTimes, 1)),
    mean: Math.round(mean(spawnTimes)),
  },
  memoryCurrentBytes: {
    mean: Math.round(mean(memoryCurrent)),
    min: memoryCurrent.length === 0 ? null : Math.min(...memoryCurrent),
    max: memoryCurrent.length === 0 ? null : Math.max(...memoryCurrent),
  },
  anonBytes: {
    mean: Math.round(mean(anon)),
    min: anon.length === 0 ? null : Math.min(...anon),
    max: anon.length === 0 ? null : Math.max(...anon),
  },
  limits: config.limits,
  limitsApplied,
  samples,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (samples.length !== iterations || !limitsApplied) {
  process.exitCode = 1;
}
