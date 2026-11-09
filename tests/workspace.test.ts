import { describe, expect, test } from "bun:test";

const APP_NAMES = [
  "user-app",
  "user-api",
  "staff-app",
  "staff-api",
  "workers",
  "plugin-host",
] as const;

const PACKAGE_NAMES = [
  "db",
  "domain",
  "cache",
  "content",
  "templates",
  "plugin-sdk",
  "i18n",
  "flags",
  "storage",
  "ui",
  "config",
  "test-utils",
] as const;

interface Manifest {
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

async function readManifest(relativePath: string): Promise<Manifest> {
  return (await Bun.file(new URL(relativePath, import.meta.url)).json()) as Manifest;
}

describe("workspace shells", () => {
  for (const name of APP_NAMES) {
    test(`apps/${name} is a workspace package with a typecheck script`, async () => {
      const manifest = await readManifest(`../apps/${name}/package.json`);

      expect(manifest.name).toBe(`@bulletin/${name}`);
      expect(manifest.scripts?.typecheck).toBeString();
    });
  }

  for (const name of PACKAGE_NAMES) {
    test(`packages/${name} is a workspace package with a typecheck script`, async () => {
      const manifest = await readManifest(`../packages/${name}/package.json`);

      expect(manifest.name).toBe(`@bulletin/${name}`);
      expect(manifest.scripts?.typecheck).toBeString();
    });
  }
});
