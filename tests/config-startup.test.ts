import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const SERVICES = ["user-api", "staff-api", "workers", "plugin-host"] as const;

const DEV_SECRET = "bulletin-development-only-session-secret";

describe("production configuration validation", () => {
  for (const service of SERVICES) {
    test(`${service} rejects the development session secret before startup`, async () => {
      const child = Bun.spawn(["bun", `apps/${service}/src/index.ts`], {
        cwd: repositoryRoot,
        env: {
          ...Bun.env,
          NODE_ENV: "production",
          DATABASE_URL: "postgres://bulletin:production@db:5432/bulletin",
          SESSION_SECRET: DEV_SECRET,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => child.kill(), 10_000);
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(timer);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("SESSION_SECRET");
      expect(stderr).toContain("development default");
    });
  }
});
