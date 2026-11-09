import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@bulletin/config";
import { Broker } from "../broker/broker.ts";
import { BrokerChannel } from "../broker/channel.ts";
import { dropPlugin, PluginDatabase } from "../broker/database.ts";
import { EgressProxy } from "../broker/egress.ts";
import { loadPluginManifest, loadPluginMigrations } from "../broker/manifest.ts";
import { loadPluginHostConfig, type PluginHostConfig } from "../config.ts";
import { resolveSandboxCgroupRoot } from "../sandbox/cgroup.ts";
import { buildSeccompPolicy, sandboxArch } from "../sandbox/seccomp.ts";
import { SandboxSupervisor } from "../sandbox/supervisor.ts";
import type { SandboxLimits } from "../sandbox/types.ts";

const MALICIOUS_BUNDLE = fileURLToPath(new URL("./plugin", import.meta.url));
const DEMO_BUNDLE = fileURLToPath(new URL("../spike/plugin", import.meta.url));
const enabled = Bun.env.BULLETIN_SANDBOX_TESTS === "1" && typeof Bun.env.DATABASE_URL === "string";
const sandboxDescribe = enabled ? describe : describe.skip;

interface CaseOptions {
  readonly limits?: SandboxLimits;
  /** Fork and memory cases may die before reporting. */
  readonly allowFailure?: boolean;
  /** A contained fork bomb may also hang inside spawn(); accept no result. */
  readonly allowHungResult?: boolean;
  readonly resultTimeoutMs?: number;
}

interface CaseContext {
  readonly result: Record<string, unknown> | undefined;
  readonly supervisor: SandboxSupervisor;
  readonly startError: unknown;
}

interface LogRecord {
  readonly message?: string;
  readonly fields?: Record<string, unknown>;
}

let config: PluginHostConfig;
let adminUrl: string;
let cgroupRoot: string;
let seccompPolicy: string;
let pluginId: string;
let database: PluginDatabase | undefined;
let broker: Broker | undefined;
let logger: ReturnType<typeof createLogger>;
const lines: string[] = [];

function parseLine(line: string): LogRecord | undefined {
  try {
    return JSON.parse(line) as LogRecord;
  } catch {
    return undefined;
  }
}

function findResult(caseName: string): Record<string, unknown> | undefined {
  for (const line of lines) {
    const record = parseLine(line);

    if (record?.message === "plugin.log" && record.fields?.case === caseName) {
      return record.fields;
    }
  }

  return undefined;
}

async function waitForResult(
  caseName: string,
  supervisor: SandboxSupervisor,
  options: CaseOptions,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = findResult(caseName);

    if (result !== undefined) {
      return result;
    }

    const state = supervisor.status().state;

    if (options.allowFailure === true && (state === "failed" || state === "stopped")) {
      return undefined;
    }

    await Bun.sleep(20);
  }

  if (options.allowHungResult === true) {
    return undefined;
  }

  throw new Error(
    `Timed out waiting for malicious case ${caseName}. Last logs:\n${lines.slice(-8).join("\n")}`,
  );
}

async function readCgroupPids(supervisor: SandboxSupervisor): Promise<number | undefined> {
  const childPid = supervisor.status().childPid;

  if (childPid === null) {
    return undefined;
  }

  try {
    const text = await Bun.file(join(cgroupRoot, `NSJAIL.${childPid}`, "pids.current")).text();
    return Number(text.trim());
  } catch {
    return undefined;
  }
}

async function killCgroup(supervisor: SandboxSupervisor): Promise<void> {
  const childPid = supervisor.status().childPid;

  if (childPid === null) {
    return;
  }

  const path = join(cgroupRoot, `NSJAIL.${childPid}`, "cgroup.kill");
  await Bun.write(path, "1").catch(() => undefined);
}

async function withCase(
  caseName: string,
  options: CaseOptions,
  run: (context: CaseContext) => Promise<void>,
): Promise<void> {
  if (broker === undefined) {
    throw new Error("Malicious suite is not initialised");
  }

  lines.length = 0;
  const channel = new BrokerChannel({
    socketPath: join(config.stateDir, `malicious-${randomUUID()}.sock`),
    logger,
    handler: broker,
  });
  await channel.start();

  const supervisor = new SandboxSupervisor({
    pluginId,
    bundlePath: MALICIOUS_BUNDLE,
    socketPath: channel.socketPath,
    nsjailPath: config.nsjailPath,
    rootfsPath: config.rootfsPath,
    cgroupV2Mount: cgroupRoot,
    seccompPolicy,
    limits: options.limits ?? config.limits,
    channel,
    logger,
    readyTimeoutMs: 10_000,
    command: ["/bin/bun", "/plugin/server.ts", caseName],
  });

  try {
    let startError: unknown;

    try {
      await supervisor.start();
    } catch (error) {
      if (options.allowFailure !== true) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nLast logs:\n${lines
            .slice(-12)
            .join("\n")}`,
        );
      }

      startError = error;
    }

    const result =
      supervisor.ready || options.allowFailure !== true
        ? await waitForResult(caseName, supervisor, options, options.resultTimeoutMs ?? 15_000)
        : undefined;

    await run({ result, supervisor, startError });
  } finally {
    await supervisor.stop().catch(() => undefined);
    await channel.close();
    await killCgroup(supervisor);
  }
}

async function expectBenignSandbox(): Promise<void> {
  if (broker === undefined) {
    throw new Error("Malicious suite is not initialised");
  }

  const channel = new BrokerChannel({
    socketPath: join(config.stateDir, `benign-${randomUUID()}.sock`),
    logger,
    handler: broker,
  });
  await channel.start();

  const supervisor = new SandboxSupervisor({
    pluginId,
    bundlePath: DEMO_BUNDLE,
    socketPath: channel.socketPath,
    nsjailPath: config.nsjailPath,
    rootfsPath: config.rootfsPath,
    cgroupV2Mount: cgroupRoot,
    seccompPolicy,
    limits: config.limits,
    channel,
    logger,
    readyTimeoutMs: 10_000,
  });

  try {
    const status = await supervisor.start();
    expect(status.state).toBe("ready");
  } finally {
    await supervisor.stop().catch(() => undefined);
    await channel.close();
    await killCgroup(supervisor);
  }
}

sandboxDescribe("malicious plugin cases", () => {
  beforeAll(async () => {
    config = loadPluginHostConfig(Bun.env);
    adminUrl = Bun.env.DATABASE_URL as string;
    cgroupRoot = await resolveSandboxCgroupRoot(config.cgroupV2Mount);
    seccompPolicy = buildSeccompPolicy(sandboxArch(process.arch));
    pluginId = `malicious-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    logger = createLogger({
      service: "malicious-test",
      level: "debug",
      sink: (line) => lines.push(line),
    });

    const manifest = await loadPluginManifest(DEMO_BUNDLE);
    const migrations = await loadPluginMigrations(DEMO_BUNDLE, manifest);
    database = await PluginDatabase.open({
      adminUrl,
      pluginId,
      migrations,
      logger,
    });
    const egress = new EgressProxy({
      allowedHosts: [],
      logger: logger.child({ component: "egress" }),
    });
    broker = new Broker({ database, egress, logger });
  }, 30_000);

  afterAll(async () => {
    await broker?.close();

    if (typeof pluginId === "string" && pluginId !== "") {
      await dropPlugin({ adminUrl, pluginId }).catch(() => undefined);
    }
  }, 30_000);

  test("denies reading core through the broker and keeps serving the plugin", async () => {
    await withCase("read-core", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
      expect(result?.recovered).toBe(true);
      expect(String(result?.detail)).toContain("schema");
    });
  }, 30_000);

  test("denies reading pii through the broker", async () => {
    await withCase("read-pii", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
      expect(result?.recovered).toBe(true);
      expect(String(result?.detail)).toContain("schema");
    });
  }, 30_000);

  test("denies runtime DDL", async () => {
    await withCase("runtime-ddl", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
      expect(result?.recovered).toBe(true);
    });
  }, 30_000);

  test("denies LISTEN before it reaches Postgres", async () => {
    await withCase("listen", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
      expect(result?.recovered).toBe(true);
    });
  }, 30_000);

  test("cannot open a TCP socket from the empty network namespace", async () => {
    await withCase("tcp-socket", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
      expect(String(result?.detail)).not.toBe("connected");
    });
  }, 30_000);

  test("cannot read a sibling bundle or host paths", async () => {
    await withCase("sibling-bundle", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
      expect(result?.currentBundleVisible).toBe(true);
    });
  }, 30_000);

  test("does not expose broker or host secrets in the environment", async () => {
    await withCase("environment", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
      expect(result?.keys).toEqual(expect.arrayContaining(["PLUGIN_ID", "PLUGIN_SOCKET"]));
    });
  }, 30_000);

  test("cannot read the host /proc", async () => {
    await withCase("proc", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
    });
  }, 30_000);

  test("contains a fork bomb and keeps the supervisor healthy", async () => {
    const limits = { ...config.limits, pids: 32, nproc: 32 };

    await withCase(
      "fork-bomb",
      {
        limits,
        allowFailure: true,
        allowHungResult: true,
        resultTimeoutMs: 5_000,
      },
      async ({ result, supervisor }) => {
        if (result === undefined) {
          expect(["ready", "failed"]).toContain(supervisor.status().state);
          const pids = await readCgroupPids(supervisor);

          if (pids !== undefined) {
            expect(pids).toBeLessThanOrEqual(limits.pids);
          }
        } else {
          expect(result.ok).toBe(true);
          expect(Number(result.spawned)).toBeLessThanOrEqual(limits.pids);
        }
      },
    );

    await expectBenignSandbox();
  }, 40_000);

  test("contains memory exhaustion and keeps the supervisor healthy", async () => {
    const limits = { ...config.limits, memoryBytes: 128 * 1024 * 1024 };

    await withCase(
      "memory-exhaustion",
      { limits, allowFailure: true },
      async ({ result, supervisor }) => {
        if (result === undefined) {
          expect(supervisor.status().state).toBe("failed");
        } else {
          expect(result.ok).toBe(false);
        }
      },
    );

    await expectBenignSandbox();
  }, 40_000);
});
