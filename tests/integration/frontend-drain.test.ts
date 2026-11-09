import { afterEach, describe, expect, test } from "bun:test";
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

    const child = Bun.spawn(
      ["bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4410"],
      {
        cwd: fileURLToPath(new URL("../../apps/staff-app", import.meta.url)),
        env: {
          ...Bun.env,
          STAFF_API_INTERNAL_URL: `http://127.0.0.1:${stalledApi.port}`,
          BULLETIN_DRAIN_TIMEOUT_MS: "100",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    try {
      await waitFor("http://127.0.0.1:4410/health/live");

      const pending = fetch("http://127.0.0.1:4410/health/ready").catch(() => null);
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
  }, 45_000);
});
