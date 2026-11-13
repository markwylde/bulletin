import type { Logger } from "@bulletin/config";
import type { BrokerChannel, PluginHello } from "../broker/channel.ts";
import { checkAppliedLimits, describeLimitMismatches } from "./limits.ts";
import { buildNsjailArgs, JAIL_BUNDLE_PATH, NSJAIL_ENVIRONMENT, sandboxUid } from "./nsjail.ts";
import { findChildPid, readProcessTreeRssBytes, readSandboxCgroup } from "./procfs.ts";
import type { SandboxCgroupUsage, SandboxLimits, SandboxState, SandboxStatus } from "./types.ts";

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

/** Exponential restart policy for a sandbox that exits or fails to start. */
export interface SandboxRestartPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor?: number;
  /** Give up after this many consecutive restarts (the circuit breaker adds auto-disable). */
  readonly maxRestarts?: number;
}

const DEFAULT_RESTART_FACTOR = 2;
const DEFAULT_MAX_RESTARTS = 5;

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
  /** Test seam: reads the sandbox's own cgroup. Defaults to reading `/proc`-backed files. */
  readonly readCgroup?: (
    cgroupV2Mount: string,
    childPid: number,
  ) => Promise<SandboxCgroupUsage | undefined>;
  /** Fail a sandbox whose cgroup limits did not stick. Defaults to `true`. */
  readonly verifyLimits?: boolean;
  /** Restart after an unexpected exit or failed start. Omit to keep a one-shot sandbox. */
  readonly restart?: SandboxRestartPolicy;
  /** Supervisor-side wall-clock watchdog; defaults to the nsjail limit plus a grace second. */
  readonly maxLifetimeMs?: number;
  readonly now?: () => number;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const MAX_REMEMBERED_STDERR_LINES = 20;
/** One plugin output line is truncated to this many characters before it is logged. */
const MAX_OUTPUT_LINE_CHARS = 8 * 1024;
/** Caps supervisor log throughput per sandbox so a noisy plugin cannot flood the host. */
const MAX_OUTPUT_LINES_PER_SECOND = 40;
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
  #logWindowStartedAt = 0;
  #logLinesThisWindow = 0;
  #suppressedLogLines = 0;
  #truncatedLogLines = 0;

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
  #restarts = 0;
  #restartAt: string | null = null;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  #stopping = false;
  #started = false;

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
      restarts: this.#restarts,
      restartAt: this.#restartAt,
    };
  }

  /**
   * Spawns the sandbox and resolves once the broker handshake arrives and its limits are
   * verified. Failures schedule an exponential restart when a restart policy is set.
   */
  async start(): Promise<SandboxStatus> {
    if (this.#state === "ready" || this.#state === "starting") {
      return this.status();
    }

    this.#stopping = false;
    this.#started = true;
    this.#cancelRestart();

    try {
      const status = await this.#startOnce();
      this.#armLifetime();
      return status;
    } catch (error) {
      this.#scheduleRestart(error);
      throw error;
    }
  }

  async #startOnce(): Promise<SandboxStatus> {
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
    this.#logWindowStartedAt = Date.now();
    this.#logLinesThisWindow = 0;
    this.#suppressedLogLines = 0;
    this.#truncatedLogLines = 0;
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

    if (outcome.hello.pluginId !== this.pluginId) {
      await this.#killAndWait();
      this.#state = "failed";
      this.#error = `Sandbox announced plugin ${outcome.hello.pluginId}, expected ${this.pluginId}`;
      this.#logger.error("sandbox.handshake_identity_mismatch", {
        announced: outcome.hello.pluginId,
        expected: this.pluginId,
      });
      throw new Error(this.#error);
    }

    const resolveChildPid = this.#options.resolveChildPid ?? ((pid: number) => findChildPid(pid));
    this.#childPid = (await resolveChildPid(child.pid)) ?? null;
    this.#startupMs = this.#now() - startedAt;
    const usage = await this.#readMetrics();
    const limitError = this.#limitsNotApplied(usage);

    if (limitError !== undefined) {
      this.#logger.error("sandbox.limits_not_applied", { error: limitError });
      await this.#killAndWait();
      this.#state = "failed";
      this.#error = limitError;
      throw new Error(limitError);
    }

    this.#readyAt = new Date().toISOString();
    this.#state = "ready";

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

  /** Stops the sandbox, escalating to SIGKILL after the grace period. Cancels any restart. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#cancelRestart();
    this.#clearLifetime();

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
      this.#scheduleRestart(new Error(this.#error));
    }
  }

  /** Arms the supervisor-side watchdog; nsjail's own time limit is the first line. */
  #armLifetime(): void {
    this.#clearLifetime();
    const lifetimeMs =
      this.#options.maxLifetimeMs ?? this.#options.limits.wallClockSeconds * 1_000 + 1_000;

    this.#lifetimeTimer = setTimeout(() => {
      if (this.#state !== "ready" || this.#process === undefined) {
        return;
      }

      const message = `Sandbox exceeded its ${lifetimeMs} ms wall-clock limit`;
      this.#logger.error("sandbox.lifetime_exceeded", { lifetimeMs });
      this.#error = message;
      this.#state = "failed";
      void this.#killAndWait().then(() => this.#scheduleRestart(new Error(message)));
    }, lifetimeMs);
    this.#lifetimeTimer.unref?.();
  }

  #clearLifetime(): void {
    if (this.#lifetimeTimer !== undefined) {
      clearTimeout(this.#lifetimeTimer);
      this.#lifetimeTimer = undefined;
    }
  }

  #scheduleRestart(error: unknown): void {
    const policy = this.#options.restart;

    if (
      policy === undefined ||
      this.#stopping ||
      !this.#started ||
      this.#restartTimer !== undefined
    ) {
      return;
    }

    const maxRestarts = policy.maxRestarts ?? DEFAULT_MAX_RESTARTS;

    if (this.#restarts >= maxRestarts) {
      this.#logger.error("sandbox.restart_exhausted", {
        restarts: this.#restarts,
        error,
      });
      return;
    }

    const factor = policy.factor ?? DEFAULT_RESTART_FACTOR;
    const delay = Math.min(
      policy.maxDelayMs,
      Math.round(policy.initialDelayMs * factor ** this.#restarts),
    );
    this.#restarts += 1;
    this.#restartAt = new Date(Date.now() + delay).toISOString();
    this.#logger.warn("sandbox.restart_scheduled", {
      attempt: this.#restarts,
      delayMs: delay,
      error,
    });

    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      this.#restartAt = null;

      if (this.#stopping) {
        return;
      }

      void this.#startOnce().then(
        () => this.#armLifetime(),
        (restartError: unknown) => {
          this.#scheduleRestart(restartError);
        },
      );
    }, delay);
    this.#restartTimer.unref?.();
  }

  #cancelRestart(): void {
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }

    this.#restartAt = null;
  }

  async #readMetrics(): Promise<SandboxCgroupUsage | undefined> {
    if (this.#childPid === null) {
      this.#cgroup = null;
      this.#memoryBytes = this.#pid === null ? null : await readProcessTreeRssBytes(this.#pid);
      return undefined;
    }

    const read = this.#options.readCgroup ?? readSandboxCgroup;
    const cgroup = await read(this.#options.cgroupV2Mount, this.#childPid);
    this.#cgroup = cgroup ?? null;
    this.#memoryBytes =
      cgroup?.memoryCurrentBytes ??
      (this.#pid === null ? null : await readProcessTreeRssBytes(this.#pid));
    return cgroup;
  }

  /**
   * `verifyLimits` defaults to on: a sandbox whose cgroup limits did not stick (for example
   * because the engine did not delegate a controller) must never serve plugin code.
   */
  #limitsNotApplied(usage: SandboxCgroupUsage | undefined): string | undefined {
    if (this.#options.verifyLimits === false) {
      return undefined;
    }

    if (this.#childPid === null) {
      return "Could not find the sandbox process to verify its cgroup limits";
    }

    if (usage === undefined) {
      return `Could not read the sandbox cgroup at ${this.#options.cgroupV2Mount} to verify its limits`;
    }

    const mismatches = checkAppliedLimits(usage, this.#options.limits);

    return mismatches.length === 0
      ? undefined
      : `Sandbox enforced different limits: ${describeLimitMismatches(mismatches)}`;
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
      let truncated = false;

      const consume = (text: string): void => {
        let index = 0;

        while (index < text.length) {
          const newline = text.indexOf("\n", index);
          const end = newline === -1 ? text.length : newline;
          const segment = text.slice(index, end);

          if (!truncated) {
            const room = MAX_OUTPUT_LINE_CHARS - buffer.length;

            if (segment.length <= room) {
              buffer += segment;
            } else {
              buffer += segment.slice(0, Math.max(0, room));
              truncated = true;
            }
          }

          if (newline === -1) {
            break;
          }

          this.#logSandboxLine(level, buffer, truncated);
          buffer = "";
          truncated = false;
          index = newline + 1;
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          consume(decoder.decode(value, { stream: true }));
        }

        consume(decoder.decode());

        if (buffer !== "" || truncated) {
          this.#logSandboxLine(level, buffer, truncated);
        }
      } catch (error) {
        this.#logger.debug("sandbox.log_stream_failed", { error });
      } finally {
        this.#flushLogBudget();
      }
    })();
  }

  #logSandboxLine(level: "warn" | "debug", line: string, truncated: boolean): void {
    if (line.trim() === "") {
      return;
    }

    const safeLine =
      line.length > MAX_OUTPUT_LINE_CHARS
        ? `${line.slice(0, MAX_OUTPUT_LINE_CHARS)}…`
        : truncated
          ? `${line}…`
          : line;

    if (truncated) {
      this.#truncatedLogLines += 1;
    }

    if (level === "warn") {
      this.#stderrLines.push(safeLine);

      if (this.#stderrLines.length > MAX_REMEMBERED_STDERR_LINES) {
        this.#stderrLines.shift();
      }
    }

    if (!this.#takeLogBudget()) {
      this.#suppressedLogLines += 1;
      return;
    }

    this.#logger[level]("sandbox.output", {
      line: safeLine,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  #takeLogBudget(): boolean {
    const now = Date.now();

    if (now - this.#logWindowStartedAt >= 1_000) {
      this.#reportSuppressedOutput();
      this.#logWindowStartedAt = now;
      this.#logLinesThisWindow = 0;
    }

    if (this.#logLinesThisWindow >= MAX_OUTPUT_LINES_PER_SECOND) {
      return false;
    }

    this.#logLinesThisWindow += 1;
    return true;
  }

  #flushLogBudget(): void {
    this.#reportSuppressedOutput();
    this.#logWindowStartedAt = Date.now();
    this.#logLinesThisWindow = 0;
  }

  #reportSuppressedOutput(): void {
    if (this.#suppressedLogLines === 0 && this.#truncatedLogLines === 0) {
      return;
    }

    this.#logger.warn("sandbox.output_suppressed", {
      lines: this.#suppressedLogLines,
      truncatedLines: this.#truncatedLogLines,
    });
    this.#suppressedLogLines = 0;
    this.#truncatedLogLines = 0;
  }
}
