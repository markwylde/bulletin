import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginManifest, loadPluginMigrations, parsePluginManifest } from "./manifest.ts";

const REAL_BUNDLE = fileURLToPath(new URL("../spike/plugin", import.meta.url));

async function withBundle<T>(
  files: Readonly<Record<string, string>>,
  run: (bundlePath: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "bulletin-manifest-"));

  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(directory, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content);
    }

    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const VALID = {
  id: "sandbox-demo",
  name: "Demo",
  version: "0.0.0",
  sdkVersion: "0.0.0",
  entry: "server.ts",
  egressHosts: ["example.com", "api.example.org"],
  migrations: ["migrations/0001_notes.sql"],
} as const;

describe("plugin manifest", () => {
  test("parses the spike bundle and its migration", async () => {
    const manifest = await loadPluginManifest(REAL_BUNDLE);

    expect(manifest.id).toBe("sandbox-demo");
    expect(manifest.egressHosts).toEqual(["example.com"]);
    expect(manifest.migrations).toEqual(["migrations/0001_notes.sql"]);

    const migrations = await loadPluginMigrations(REAL_BUNDLE, manifest);
    expect(migrations.map((migration) => migration.name)).toEqual(["migrations/0001_notes.sql"]);
    expect(migrations[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS notes");
  });

  test("accepts a valid manifest and ignores unknown fields", () => {
    expect(parsePluginManifest({ ...VALID, extra: true })).toEqual({
      id: "sandbox-demo",
      name: "Demo",
      version: "0.0.0",
      sdkVersion: "0.0.0",
      entry: "server.ts",
      egressHosts: ["example.com", "api.example.org"],
      migrations: ["migrations/0001_notes.sql"],
    });
  });

  test("defaults optional arrays", () => {
    const { egressHosts: _egress, migrations: _migrations, ...rest } = VALID;
    expect(parsePluginManifest(rest)).toMatchObject({ egressHosts: [], migrations: [] });
  });

  test("rejects an id that cannot become a role name", () => {
    expect(() => parsePluginManifest({ ...VALID, id: "Sandbox" })).toThrow("id must be");
    expect(() => parsePluginManifest({ ...VALID, id: "a".repeat(56) })).toThrow("id must be");
    expect(() => parsePluginManifest({ ...VALID, id: "a_b" })).toThrow("id must be");
  });

  test("rejects unsafe egress hosts", () => {
    for (const host of [
      "https://example.com",
      "Example.com",
      "example.com.",
      ".example.com",
      "example..com",
      "exa mple.com",
    ]) {
      expect(() => parsePluginManifest({ ...VALID, egressHosts: [host] })).toThrow(
        "invalid egress host",
      );
    }
  });

  test("rejects migration path traversal and absolute paths", () => {
    for (const path of ["../evil.sql", "/tmp/evil.sql", "migrations\\evil.sql", "readme.md"]) {
      expect(() => parsePluginManifest({ ...VALID, migrations: [path] })).toThrow(
        "invalid migration path",
      );
    }
  });

  test("rejects malformed manifests", async () => {
    await withBundle({ "plugin.json": "not json" }, async (bundle) => {
      await expect(loadPluginManifest(bundle)).rejects.toThrow("not valid JSON");
    });

    await withBundle({ "plugin.json": JSON.stringify({ ...VALID, name: "" }) }, async (bundle) => {
      await expect(loadPluginManifest(bundle)).rejects.toThrow("name must be");
    });
  });
});
