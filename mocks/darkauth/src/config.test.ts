import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

const directories: string[] = [];

async function writeConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "darkauth-config-"));
  directories.push(directory);
  const path = join(directory, "darkauth-mock.yaml");

  await Bun.write(
    path,
    `server:
  host: 0.0.0.0
  port: 3020
  issuer: http://auth.bulletin.localhost:8080
  allowedOrigins:
    - http://bulletin.localhost:8080
clients:
  - id: bulletin-user
users:
  - sub: admin
    email: admin@bulletin.test
    name: Admin
`,
  );

  return path;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("darkauth mock config", () => {
  test("uses the yaml issuer and origins when no environment override is set", async () => {
    const config = await loadConfig(await writeConfig(), {});

    expect(config.issuer).toBe("http://auth.bulletin.localhost:8080");
    expect(config.allowedOrigins).toEqual(["http://bulletin.localhost:8080"]);
  });

  test("lets the environment override the issuer and allowed origins", async () => {
    const config = await loadConfig(await writeConfig(), {
      DARKAUTH_MOCK_ISSUER: "http://auth.bulletin.localhost:18080/",
      DARKAUTH_MOCK_ALLOWED_ORIGINS:
        "http://bulletin.localhost:18080, http://staff.bulletin.localhost:18080",
    });

    expect(config.issuer).toBe("http://auth.bulletin.localhost:18080");
    expect(config.allowedOrigins).toEqual([
      "http://bulletin.localhost:18080",
      "http://staff.bulletin.localhost:18080",
    ]);
  });

  test("rejects a config without clients or users", async () => {
    const path = await writeConfig();
    await Bun.write(path, "server:\n  port: 3020\n");

    await expect(loadConfig(path, {})).rejects.toThrow(
      "DarkAuth mock config needs at least one client and one user",
    );
  });
});
