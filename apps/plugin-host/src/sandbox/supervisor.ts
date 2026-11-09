import type { Logger } from "@bulletin/config";
import type { BrokerChannel, PluginHello } from "../broker/channel.ts";
import { buildNsjailArgs, JAIL_BUNDLE_PATH, NSJAIL_ENVIRONMENT, sandboxUid } from "./nsjail.ts";
import { findChildPid, readProcessTreeRssBytes, readSandboxCgroup } from "./procfs.ts";
import type { SandboxLimits, SandboxState, SandboxStatus } from "./types.ts";

export interface SandboxProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
}

export type SpawnSandbox = (
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => SandboxProcess;

export interface SandboxSupervisorOptions {
  readonly pluginId: string;
  readonly bundlePath: string;
  readonly socketPath: string;
  readonly nsjailPath: string;
  readonly rootfsPath: string;
  readonly cgroupV2Mount: string;
  readonly seccompPolicy: string;
  readonly limits: SandboxLimits;
  readonly channel: BrokerChannel;
  readonly logger: Logger;
  /** Time allowed for nsjail + Bun + the broker handshake. */
  readonly readyTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Jail command; defaults to the demo plugin. Tests use a different fixture entry. */
  readonly command?: readonly string[];
  readonly spawn?: SpawnSandbox;
  /** Test seam: finds nsjail's clone target. Defaults to reading `/proc`. */
  readonly resolveChildPid?: (pid: number) => Promise<number | undefined>;
  readonly now?: () => number;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const MAX_REMEMBERED_STDERR_LINES = 20;
const JAIL_COMMAND = ["/bin/bun", `${JAIL_BUNDLE_PATH}/server.ts`] as const;

type StartOutcome =
  | { readonly kind: "hello"; readonly hello: PluginHello }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "exit"; readonly code: number };

function spawnWithBun(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): SandboxProcess {
  const child = Bun.spawn([...args], {
    env: { ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    pid: child.pid,
    exited: child.exited,
    kill: (signal) => {
      child.kill(signal);
    },
    stdout: child.stdout as ReadableStream<Uint8Array> | null,
    stderr: child.stderr as ReadableStream<Uint8Array> | null,
  };
}

/**
 * Spawns, watches and stops one plugin process under nsjail. The prototype keeps a single
 * sandbox; `plugin-platform` generalises it to a supervised pool.
 */
export class SandboxSupervisor {
  readonly pluginId: string;
  readonly #options: SandboxSupervisorOptions;
  readonly #logger: Logger;
  readonly #spawn: SpawnSandbox;
  readonly #now: () => number;
  readonly #stderrLines: string[] = [];

  #state: SandboxState = "idle";
  #process: SandboxProcess | undefined;
  #pid: number | null = null;
  #childPid: number | null = null;
  #startedAt: string | null = null;
  #readyAt: string | null = null;
  #startupMs: number | null = null;
  #memoryBytes: number | null = null;
  #cgroup: SandboxStatus["cgroup"] = null;
  #exitCode: number | null = null;
  #error: string | null = null;

  constructor(options: SandboxSupervisorOptions) {
    this.pluginId = options.pluginId;
    this.#options = options;
    this.#logger = options.logger.child({ pluginId: options.pluginId });
    this.#spawn = options.spawn ?? spawnWithBun;
    this.#now = options.now ?? (() => performance.now());
  }

  get state(): SandboxState {
    return this.#state;
  }

  get ready(): boolean {
    return this.#state === "ready";
  }

  status(): SandboxStatus {
    return {
      pluginId: this.pluginId,
      state: this.#state,
      pid: this.#pid,
      childPid: this.#childPid,
      startedAt: this.#startedAt,
      readyAt: this.#readyAt,
      startupMs: this.#startupMs,
      memoryBytes: this.#memoryBytes,
      cgroup: this.#cgroup,
      exitCode: this.#exitCode,
      error: this.#error,
    };
  }

  /** Spawns the sandbox and resolves once the broker handshake arrives. */
  async start(): Promise<SandboxStatus> {
    if (this.#state === "ready" || this.#state === "starting") {
      return this.status();
    }

    const uid = sandboxUid(this.pluginId);
    let args: string[];

    try {
      args = buildNsjailArgs({
        pluginId: this.pluginId,
        rootfsPath: this.#options.rootfsPath,
        bundlePath: this.#options.bundlePath,
        socketPath: this.#options.socketPath,
        uid,
        gid: uid,
        cgroupV2Mount: this.#options.cgroupV2Mount,
        seccompPolicy: this.#options.seccompPolicy,
        limits: this.#options.limits,
        command: this.#options.command ?? JAIL_COMMAND,
      });
    } catch (error) {
      this.#state = "failed";
      this.#error = error instanceof Error ? error.message : String(error);
      this.#logger.error("sandbox.invalid_config", { error });
      throw error;
    }

    this.#state = "starting";
    this.#error = null;
    this.#exitCode = null;
    this.#childPid = null;
    this.#readyAt = null;
    this.#startupMs = null;
    this.#memoryBytes = null;
    this.#cgroup = null;
    this.#stderrLines.length = 0;
    this.#startedAt = new Date().toISOString();
    const startedAt = this.#now();

    const helloOutcome = this.#options.channel
      .waitForHello(this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
      .then(
        (hello): StartOutcome => ({ kind: "hello", hello }),
        (error: Error): StartOutcome => ({ kind: "error", error }),
      );

    let child: SandboxProcess;

    try {
      child = this.#spawn([this.#options.nsjailPath, ...args], NSJAIL_ENVIRONMENT);
    } catch (error) {
      this.#state = "failed";
      this.#error = error instanceof Error ? error.message : String(error);
      this.#options.channel.cancelHello("Sandbox failed to spawn");
      this.#logger.error("sandbox.spawn_failed", { error });
      throw error;
    }

    this.#process = child;
    this.#pid = child.pid;
    this.#drain(child);

    const exitOutcome = child.exited.then((code): StartOutcome => ({ kind: "exit", code }));
    const outcome = await Promise.race([helloOutcome, exitOutcome]);

    if (outcome.kind === "exit") {
      this.#onExit(outcome.code);
      this.#options.channel.cancelHello("Sandbox exited before the handshake");
      throw new Error(this.#error ?? `Sandbox exited before the handshake (code ${outcome.code})`);
    }

    if (outcome.kind === "error") {
      await this.#killAndWait();
      this.#state = "failed";
      this.#error = outcome.error.message;
      this.#logger.error("sandbox.handshake_failed", { error: outcome.error });
      throw outcome.error;
    }

    const resolveChildPid = this.#options.resolveChildPid ?? ((pid: number) => findChildPid(pid));
    this.#childPid = (await resolveChildPid(child.pid)) ?? null;
    this.#startupMs = this.#now() - startedAt;
    this.#readyAt = new Date().toISOString();
    this.#state = "ready";
    await this.#readMetrics();

    // Keep watching for the rest of the sandbox's life, not just up to the handshake.
    void child.exited.then((code) => {
      if (this.#process === child) {
        this.#onExit(code);
      }
    });

    this.#logger.info("sandbox.ready", {
      startupMs: Math.round(this.#startupMs),
      memoryBytes: this.#memoryBytes,
      childPid: this.#childPid,
    });

    return this.status();
  }

  /** Stops the sandbox, escalating to SIGKILL after the grace period. */
  async stop(): Promise<void> {
    if (this.#process === undefined) {
      this.#state = "stopped";
      return;
    }

    this.#state = "stopping";
    this.#logger.info("sandbox.stopping");
    await this.#killAndWait();
    this.#state = "stopped";
    this.#logger.info("sandbox.stopped", { exitCode: this.#exitCode });
  }

  async #killAndWait(): Promise<void> {
    const child = this.#process;

    if (child === undefined) {
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }

    const stopped = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(this.#options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS).then(() => false),
    ]);

    if (!stopped) {
      this.#logger.warn("sandbox.kill_escalated");
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await child.exited.catch(() => undefined);
    }

    this.#process = undefined;
  }

  #onExit(code: number): void {
    this.#exitCode = code;
    this.#process = undefined;

    if (this.#state === "starting") {
      this.#state = "failed";
      this.#error = `Sandbox exited before the handshake (code ${code})`;
      this.#logger.error("sandbox.exited_early", {
        exitCode: code,
        stderr: this.#stderrLines,
      });
      return;
    }

    if (this.#state === "stopping") {
      this.#state = "stopped";
      return;
    }

    if (this.#state === "ready") {
      this.#state = "failed";
      this.#error = `Sandbox exited unexpectedly (code ${code})`;
      this.#logger.error("sandbox.exited_unexpectedly", {
        exitCode: code,
        stderr: this.#stderrLines,
      });
    }
  }

  async #readMetrics(): Promise<void> {
    if (this.#childPid === null) {
      return;
    }

    const cgroup = await readSandboxCgroup(this.#options.cgroupV2Mount, this.#childPid);
    this.#cgroup = cgroup ?? null;
    this.#memoryBytes =
      cgroup?.memoryCurrentBytes ??
      (this.#pid === null ? null : await readProcessTreeRssBytes(this.#pid));
  }

  #drain(child: SandboxProcess): void {
    this.#drainStream(child.stderr, "warn");
    this.#drainStream(child.stdout, "debug");
  }

  #drainStream(stream: ReadableStream<Uint8Array> | null, level: "warn" | "debug"): void {
    if (stream === null) {
      return;
    }

    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            this.#logSandboxLine(level, line);
          }
        }

        if (buffer !== "") {
          this.#logSandboxLine(level, buffer);
        }
      } catch (error) {
        this.#logger.debug("sandbox.log_stream_failed", { error });
      }
    })();
  }

  #logSandboxLine(level: "warn" | "debug", line: string): void {
    if (line.trim() === "") {
      return;
    }

    if (level === "warn") {
      this.#stderrLines.push(line);

      if (this.#stderrLines.length > MAX_REMEMBERED_STDERR_LINES) {
        this.#stderrLines.shift();
      }
    }

    this.#logger[level]("sandbox.output", { line });
  }
}
