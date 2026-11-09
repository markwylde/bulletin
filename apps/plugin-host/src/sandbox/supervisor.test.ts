import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@bulletin/config";
import { BrokerChannel } from "./channel.ts";
import { NSJAIL_ENVIRONMENT } from "./nsjail.ts";
import { type SandboxProcess, SandboxSupervisor, type SpawnSandbox } from "./supervisor.ts";
import { DEFAULT_SANDBOX_LIMITS } from "./types.ts";

const logger = createLogger({ service: "sandbox-test", level: "error", sink: () => {} });
const temporaryDirectories: string[] = [];

interface FakeSandbox {
  readonly spawn: SpawnSandbox;
  readonly process: SandboxProcess;
  readonly args: string[][];
  readonly environments: Readonly<Record<string, string>>[];
  exit(code: number): void;
}

function createFakeSandbox(hello: string | null, delayMs = 5): FakeSandbox {
  let resolveExit: (code: number) => void = () => undefined;
  const args: string[][] = [];
  const environments: Readonly<Record<string, string>>[] = [];
  const sockets: Bun.Socket[] = [];
  const sandboxProcess: SandboxProcess = {
    pid: 4242,
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
    kill() {
      resolveExit(0);
    },
    stdout: null,
    stderr: null,
  };

  const spawn: SpawnSandbox = (nextArgs, env) => {
    args.push([...nextArgs]);
    environments.push(env);

    if (hello !== null) {
      void (async () => {
        await Bun.sleep(delayMs);
        const socket = await Bun.connect({
          unix: nextArgs[nextArgs.indexOf("--bindmount") + 1]?.split(":")[0] ?? "",
          socket: {
            data() {},
            error() {},
          },
        });
        sockets.push(socket);
        socket.write(hello);
      })();
    }

    return sandboxProcess;
  };

  return {
    spawn,
    process: sandboxProcess,
    args,
    environments,
    exit(code) {
      for (const socket of sockets) {
        socket.end();
      }
      resolveExit(code);
    },
  };
}

async function createSupervisor(
  spawn: SpawnSandbox,
): Promise<{ channel: BrokerChannel; supervisor: SandboxSupervisor; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "bulletin-sandbox-"));
  temporaryDirectories.push(directory);
  const channel = new BrokerChannel({
    socketPath: join(directory, "broker.sock"),
    logger,
  });
  await channel.start();

  let clock = 0;
  const supervisor = new SandboxSupervisor({
    pluginId: "sandbox-demo",
    bundlePath: "/app/apps/plugin-host/src/spike/plugin",
    socketPath: channel.socketPath,
    nsjailPath: "/usr/bin/nsjail",
    rootfsPath: "/opt/plugin-rootfs",
    cgroupV2Mount: "/sys/fs/cgroup",
    seccompPolicy: "ALLOW { read }",
    limits: DEFAULT_SANDBOX_LIMITS,
    channel,
    logger,
    readyTimeoutMs: 500,
    spawn,
    resolveChildPid: async () => 9001,
    now: () => {
      clock += 5;
      return clock;
    },
  });

  return { channel, supervisor, directory };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("sandbox supervisor", () => {
  test("spawns nsjail and becomes ready on the broker handshake", async () => {
    const fake = createFakeSandbox(
      `${JSON.stringify({ type: "hello", pluginId: "sandbox-demo", sdkVersion: "0.0.0" })}\n`,
    );
    const { channel, supervisor } = await createSupervisor(fake.spawn);

    const status = await supervisor.start();

    expect(status.state).toBe("ready");
    expect(status.pid).toBe(4242);
    expect(status.childPid).toBe(9001);
    expect(status.startupMs).toBe(5);
    expect(status.error).toBeNull();
    expect(fake.args[0]?.[0]).toBe("/usr/bin/nsjail");
    expect(fake.args[0]).toContain("--seccomp_string");
    expect(fake.environments[0]).toEqual(NSJAIL_ENVIRONMENT);

    await supervisor.stop();
    expect(supervisor.status().state).toBe("stopped");
    await channel.close();
  });

  test("fails when the plugin sends an invalid handshake", async () => {
    const fake = createFakeSandbox("nope\n");
    const { channel, supervisor } = await createSupervisor(fake.spawn);

    await expect(supervisor.start()).rejects.toThrow("invalid broker message");
    expect(supervisor.status().state).toBe("failed");

    await channel.close();
  });

  test("fails when nsjail exits before the handshake", async () => {
    const fake = createFakeSandbox(null);
    const { channel, supervisor } = await createSupervisor(fake.spawn);

    const started = supervisor.start();
    fake.exit(2);

    await expect(started).rejects.toThrow("exited before the handshake (code 2)");
    expect(supervisor.status().state).toBe("failed");
    expect(supervisor.status().exitCode).toBe(2);
    // The failed handshake must not leave a waiter that blocks a later restart.
    await expect(channel.waitForHello(30)).rejects.toThrow("No broker handshake");

    await channel.close();
  });

  test("reports an unexpected exit after becoming ready", async () => {
    const fake = createFakeSandbox(
      `${JSON.stringify({ type: "hello", pluginId: "sandbox-demo", sdkVersion: "0.0.0" })}\n`,
    );
    const { channel, supervisor } = await createSupervisor(fake.spawn);

    await supervisor.start();
    fake.exit(9);
    await Bun.sleep(10);

    expect(supervisor.status().state).toBe("failed");
    expect(supervisor.status().error).toBe("Sandbox exited unexpectedly (code 9)");

    await channel.close();
  });

  test("does not spawn twice when already ready", async () => {
    const fake = createFakeSandbox(
      `${JSON.stringify({ type: "hello", pluginId: "sandbox-demo", sdkVersion: "0.0.0" })}\n`,
    );
    const { channel, supervisor } = await createSupervisor(fake.spawn);

    const first = await supervisor.start();
    const second = await supervisor.start();

    expect(second).toEqual(first);
    expect(fake.args).toHaveLength(1);

    await supervisor.stop();
    await channel.close();
  });
});
