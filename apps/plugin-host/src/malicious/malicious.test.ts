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
import { PluginQuotaMonitor } from "../quota/monitor.ts";
import { resolveSandboxCgroupRoot } from "../sandbox/cgroup.ts";
import { buildSeccompPolicy, sandboxArch } from "../sandbox/seccomp.ts";
import { type SandboxRestartPolicy, SandboxSupervisor } from "../sandbox/supervisor.ts";
import type { SandboxLimits } from "../sandbox/types.ts";

const MALICIOUS_BUNDLE = fileURLToPath(new URL("./plugin", import.meta.url));
const DEMO_BUNDLE = fileURLToPath(new URL("../demo/plugin", import.meta.url));
const enabled = Bun.env.BULLETIN_SANDBOX_TESTS === "1" && typeof Bun.env.DATABASE_URL === "string";
const sandboxDescribe = enabled ? describe : describe.skip;

interface CaseOptions {
  readonly limits?: SandboxLimits;
  /** The probe may be terminated during the attack; accept no result for containment. */
  readonly allowFailure?: boolean;
  /** A contained fork bomb may also hang inside spawn(); accept no result. */
  readonly allowHungResult?: boolean;
  readonly resultTimeoutMs?: number;
  /** Extra arguments after the case name, e.g. the controlled TCP listener port. */
  readonly commandArgs?: readonly string[];
  /** Override the broker (for a case-specific egress allowlist or mock). */
  readonly broker?: Broker;
  readonly restart?: SandboxRestartPolicy;
  readonly maxLifetimeMs?: number;
}

interface CgroupEvents {
  readonly memoryOom: number;
  readonly memoryOomKill: number;
  readonly memoryMax: number;
  readonly pidsMaxEvents: number;
  readonly pidsCurrentMax: number;
}

interface CgroupMonitor {
  snapshot(): CgroupEvents;
  stop(): CgroupEvents;
}

interface CaseContext {
  readonly result: Record<string, unknown> | undefined;
  readonly supervisor: SandboxSupervisor;
  readonly monitor: CgroupMonitor;
}

interface LogRecord {
  readonly message?: string;
  readonly schema?: string;
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

function findLog(caseName: string, phase: "start" | "result"): Record<string, unknown> | undefined {
  for (const line of lines) {
    const record = parseLine(line);

    if (
      record?.message === "plugin.log" &&
      record.fields?.case === caseName &&
      record.fields.phase === phase
    ) {
      return record.fields;
    }
  }

  return undefined;
}

async function waitForStarted(caseName: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (findLog(caseName, "start") !== undefined) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error(
    `Timed out waiting for malicious case ${caseName} to start. Last logs:\n${lines
      .slice(-8)
      .join("\n")}`,
  );
}

async function waitForResult(
  caseName: string,
  supervisor: SandboxSupervisor,
  options: CaseOptions,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = findLog(caseName, "result");

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

function parseCounters(text: string | undefined): Map<string, number> {
  const counters = new Map<string, number>();

  for (const line of (text ?? "").split("\n")) {
    const [name, raw] = line.trim().split(/\s+/);

    if (name !== undefined && raw !== undefined && /^\d+$/.test(raw)) {
      counters.set(name, Number(raw));
    }
  }

  return counters;
}

/** Samples cgroup counters while the attack runs, so the event survives cgroup removal. */
function startCgroupMonitor(supervisor: SandboxSupervisor): CgroupMonitor {
  const childPid = supervisor.status().childPid;
  const directory = childPid === null ? undefined : join(cgroupRoot, `NSJAIL.${childPid}`);
  const events = {
    memoryOom: 0,
    memoryOomKill: 0,
    memoryMax: 0,
    pidsMaxEvents: 0,
    pidsCurrentMax: 0,
  };
  let stopped = false;

  const sample = async (): Promise<void> => {
    if (directory === undefined) {
      return;
    }

    const [memoryText, pidsText, currentText] = await Promise.all([
      Bun.file(join(directory, "memory.events"))
        .text()
        .catch(() => undefined),
      Bun.file(join(directory, "pids.events"))
        .text()
        .catch(() => undefined),
      Bun.file(join(directory, "pids.current"))
        .text()
        .catch(() => undefined),
    ]);
    const memory = parseCounters(memoryText);
    const pids = parseCounters(pidsText);

    events.memoryOom = Math.max(events.memoryOom, memory.get("oom") ?? 0);
    events.memoryOomKill = Math.max(events.memoryOomKill, memory.get("oom_kill") ?? 0);
    events.memoryMax = Math.max(events.memoryMax, memory.get("max") ?? 0);
    events.pidsMaxEvents = Math.max(events.pidsMaxEvents, pids.get("max") ?? 0);

    if (currentText !== undefined && /^\d+$/.test(currentText.trim())) {
      events.pidsCurrentMax = Math.max(events.pidsCurrentMax, Number(currentText.trim()));
    }
  };

  void (async () => {
    while (!stopped) {
      await sample();

      if (!stopped) {
        await Bun.sleep(2);
      }
    }
  })();

  return {
    snapshot: () => ({ ...events }),
    stop: () => {
      stopped = true;
      return { ...events };
    },
  };
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
    handler: options.broker ?? broker,
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
    command: ["/bin/bun", "/plugin/server.ts", caseName, ...(options.commandArgs ?? [])],
    ...(options.restart === undefined ? {} : { restart: options.restart }),
    ...(options.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: options.maxLifetimeMs }),
  });

  let monitor: CgroupMonitor | undefined;

  try {
    try {
      await supervisor.start();
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nLast logs:\n${lines
          .slice(-12)
          .join("\n")}`,
      );
    }

    monitor = startCgroupMonitor(supervisor);
    await waitForStarted(caseName);

    const result = await waitForResult(
      caseName,
      supervisor,
      options,
      options.resultTimeoutMs ?? 15_000,
    );

    await run({ result, supervisor, monitor });
  } finally {
    monitor?.stop();
    await supervisor.stop().catch(() => undefined);
    await channel.close();
    await killCgroup(supervisor);
  }
}

function findDemoDatabaseSuccess(schema: string): Record<string, unknown> | undefined {
  for (const line of lines) {
    const record = parseLine(line);

    if (
      record?.message === "plugin.log" &&
      record.schema === schema &&
      record.fields?.insertedId !== undefined
    ) {
      return record.fields;
    }
  }

  return undefined;
}

async function waitForDemoDatabaseSuccess(
  schema: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = findDemoDatabaseSuccess(schema);

    if (result !== undefined) {
      return result;
    }

    await Bun.sleep(20);
  }

  throw new Error(
    `Timed out waiting for the benign sandbox's database operation. Last logs:
${lines.slice(-8).join("\n")}`,
  );
}

async function expectBenignSandbox(): Promise<void> {
  if (broker === undefined) {
    throw new Error("Malicious suite is not initialised");
  }

  lines.length = 0;
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

    // The demo catches DB errors. Wait for its acknowledged insert/select/log so a broken
    // broker cannot make a recovery test pass on handshake readiness alone.
    const result = await waitForDemoDatabaseSuccess(database?.schema ?? "");
    expect(result.insertedId).toBeDefined();
    expect(result.recentRows).toEqual(expect.any(Number));
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

  test("denies an oversized SQL result and keeps serving", async () => {
    await withCase("large-result", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
      expect(result?.recovered).toBe(true);
      expect(String(result?.detail)).toContain("too large");
    });
  }, 30_000);

  test("denies LISTEN before it reaches Postgres", async () => {
    await withCase("listen", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
      expect(result?.recovered).toBe(true);
    });
  }, 30_000);

  test("cannot reach a plugin-host TCP listener from the empty network namespace", async () => {
    let accepted = 0;
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          accepted += 1;
          socket.end();
        },
        data() {},
        error() {},
      },
    });

    try {
      const control = await Bun.connect({
        hostname: "127.0.0.1",
        port: listener.port,
        socket: { data() {}, error() {} },
      });
      await Bun.sleep(20);
      expect(accepted).toBe(1);
      control.end();

      await withCase("tcp-socket", { commandArgs: [String(listener.port)] }, async ({ result }) => {
        expect(result?.ok).toBe(true);
        expect(String(result?.detail)).not.toBe("connected");
        expect(accepted).toBe(1);
      });
    } finally {
      listener.stop(true);
    }
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

  test("contains an output flood and keeps the supervisor responsive", async () => {
    await withCase("output-flood", {}, async ({ result, supervisor }) => {
      expect(result?.ok).toBe(true);
      expect(supervisor.ready).toBe(true);
    });

    await expectBenignSandbox();
  }, 40_000);

  test("contains a fork bomb at the pids limit and keeps the supervisor healthy", async () => {
    const limits = {
      ...config.limits,
      // Keep the cgroup pids limit lower than RLIMIT_NPROC so the cgroup event is the cause.
      pids: 32,
      nproc: 64,
      memoryBytes: 512 * 1024 * 1024,
    };

    await withCase(
      "fork-bomb",
      {
        limits,
        allowFailure: true,
        allowHungResult: true,
        resultTimeoutMs: 5_000,
      },
      async ({ result, supervisor, monitor }) => {
        const events = monitor.snapshot();
        expect(events.pidsMaxEvents).toBeGreaterThan(0);
        expect(events.pidsCurrentMax).toBeLessThanOrEqual(limits.pids);

        expect(result?.ok).toBe(true);
        expect(supervisor.status().state).toBe("ready");
      },
    );

    await expectBenignSandbox();
  }, 40_000);

  test("denies session settings, notifications, advisory locks and sleep in SQL", async () => {
    await withCase("sql-side-effects", {}, async ({ result, supervisor }) => {
      expect(result?.ok).toBe(true);
      expect(result?.detail).toBe("");
      expect(supervisor.ready).toBe(true);
    });
  }, 30_000);

  test("rate-limits statement abuse and recovers within the plugin", async () => {
    const before = broker?.stats().rateLimited ?? 0;

    await withCase("rate-limit", {}, async ({ result }) => {
      expect(result?.ok).toBe(true);
      expect(Number(result?.denials)).toBeGreaterThan(0);
      expect(Number(result?.successes)).toBeGreaterThan(0);
      expect(result?.recovered).toBe(true);
    });

    expect((broker?.stats().rateLimited ?? 0) - before).toBeGreaterThan(0);
  }, 40_000);

  test("revokes writes over the storage quota and keeps reads working", async () => {
    if (adminUrl === undefined) {
      throw new Error("The quota case needs a database");
    }

    const monitor = new PluginQuotaMonitor({
      adminUrl,
      pluginId,
      logger,
      quotaBytes: 64 * 1024,
      intervalMs: 50,
    });
    monitor.start();

    try {
      await withCase("quota-abuse", {}, async ({ result }) => {
        expect(result?.ok).toBe(true);
        expect(String(result?.detail)).not.toBe("");
        expect(result?.readOk).toBe(true);

        const status = monitor.status();
        expect(status.exceeded).toBe(true);
        expect(status.writesRevoked).toBe(true);
      });
    } finally {
      monitor.stop();
      await monitor.restoreWrites().catch(() => undefined);
    }
  }, 40_000);

  test("denies egress SSRF variants including DNS rebinding and redirects", async () => {
    const egress = new EgressProxy({
      allowedHosts: ["example.com", "metadata.test", "rebind.test", "redirect.test"],
      logger: logger.child({ component: "egress-ssrf" }),
      lookup: async (hostname) => {
        if (hostname === "metadata.test") {
          return [{ address: "169.254.169.254", family: 4 }];
        }

        if (hostname === "rebind.test") {
          return [{ address: "127.0.0.1", family: 4 }];
        }

        return [{ address: "93.184.216.34", family: 4 }];
      },
      fetch: async (url) =>
        url.startsWith("http://redirect.test")
          ? new Response(null, {
              status: 302,
              headers: { location: "http://169.254.169.254/latest/meta-data/" },
            })
          : new Response("ok"),
    });
    const ssrfBroker = new Broker({ database: database as PluginDatabase, egress, logger });

    await withCase("egress-ssrf", { broker: ssrfBroker }, async ({ result, supervisor }) => {
      expect(result?.ok).toBe(true);
      expect(result?.detail).toBe("");
      expect(supervisor.ready).toBe(true);
    });
  }, 40_000);

  test("kills a sandbox at its wall-clock limit and restarts it", async () => {
    await withCase(
      "idle",
      {
        maxLifetimeMs: 300,
        restart: { initialDelayMs: 20, maxDelayMs: 20, maxRestarts: 2 },
      },
      async ({ supervisor }) => {
        await Bun.sleep(800);
        expect(supervisor.status().restarts).toBeGreaterThan(0);
        expect(supervisor.ready).toBe(true);
      },
    );
  }, 30_000);

  test("hits the memory cgroup limit and keeps the supervisor healthy", async () => {
    const limits = { ...config.limits, memoryBytes: 128 * 1024 * 1024 };

    await withCase(
      "memory-exhaustion",
      { limits, allowFailure: true },
      async ({ result, supervisor, monitor }) => {
        const events = monitor.snapshot();
        expect(events.memoryOom + events.memoryOomKill + events.memoryMax).toBeGreaterThan(0);

        if (result !== undefined) {
          expect(result.ok).toBe(false);
        } else {
          expect(["failed", "ready"]).toContain(supervisor.status().state);
        }
      },
    );

    await expectBenignSandbox();
  }, 40_000);
});
