import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENABLED = Bun.env.BULLETIN_INTEGRATION === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return;
      }
    } catch {
      // The dev server is still starting.
    }

    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function spawnStaffApp(port: number, apiPort: number, stdoutPath: string) {
  return Bun.spawn(
    [
      "bun",
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: fileURLToPath(new URL("../../apps/staff-app", import.meta.url)),
      env: {
        ...Bun.env,
        STAFF_API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
        BULLETIN_DRAIN_TIMEOUT_MS: "100",
      },
      // Never "pipe" an unread stdout: a cold vite start logs enough to fill the pipe and
      // block. A file keeps the output for the failure message instead.
      stdout: Bun.file(stdoutPath),
      stderr: "pipe",
    },
  );
}

/**
 * Starts the staff-app vite dev server. A Bun-spawned vite occasionally stalls during startup
 * on Linux before it logs or binds anything (its rolldown workers idle on a futex), so a start
 * that is not live within 20 s is killed and retried. The drain behaviour under test only
 * begins once the server is live.
 */
async function startStaffApp(
  apiPort: number,
): Promise<{ origin: string; child: ReturnType<typeof spawnStaffApp> }> {
  const failures: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // A free port, not a fixed one: concurrent CI runs share the host network.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const origin = `http://127.0.0.1:${port}`;
    const stdoutPath = join(tmpdir(), `bulletin-drain-${port}.log`);
    const child = spawnStaffApp(port, apiPort, stdoutPath);

    try {
      await waitFor(`${origin}/health/live`, 20_000);
      return { origin, child };
    } catch (error) {
      child.kill("SIGKILL");
      await child.exited;
      const stderr = await new Response(child.stderr).text();
      const stdout = await Bun.file(stdoutPath)
        .text()
        .catch(() => "");
      failures.push(
        `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
  }

  throw new Error(`staff-app never became live:\n${failures.join("\n")}`);
}

integrationDescribe("frontend SIGTERM drain", () => {
  test("staff-app exits after the drain deadline while readiness is pending", async () => {
    const stalledApi = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Promise<Response>(() => undefined);
      },
    });
    servers.push(stalledApi);

    const { origin, child } = await startStaffApp(stalledApi.port);

    try {
      const pending = fetch(`${origin}/health/ready`).catch(() => null);
      await Bun.sleep(50);

      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill(), 5_000);
      const exitCode = await child.exited;
      clearTimeout(timer);

      expect(exitCode).toBe(0);
      expect(await pending).toBeNull();

      const stderr = await new Response(child.stderr).text();
      expect(stderr).not.toContain("unhandled");
    } finally {
      child.kill();
    }
  }, 120_000);
});
