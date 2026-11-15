import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEV_THEME_PUBLIC_KEY, decodeThemeTar, verifyThemeBundle } from "@bulletin/domain/themes";
import { parsePluginManifest } from "@bulletin/plugin-sdk/manifest";
import { compactVerify, importJWK, type JWK } from "jose";
import { type Catalog, createMarketplaceHandler, signCatalog } from "./app.ts";
import { buildPluginPackages, buildThemePackages } from "./packages.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

const catalog: Catalog = { version: 1, generatedAt: "2026-01-01T00:00:00.000Z", packages: [] };

async function start() {
  const signed = await signCatalog(catalog);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createMarketplaceHandler(catalog, signed),
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, signed };
}

describe("marketplace mock", () => {
  test("serves an empty catalogue signed with the dev key", async () => {
    const { base, signed } = await start();
    const keys = (await (await fetch(`${base}/keys.json`)).json()) as { keys: JWK[] };
    const key = await importJWK(keys.keys[0] as JWK, "EdDSA");

    const verified = await compactVerify(signed, key);
    const payload = JSON.parse(new TextDecoder().decode(verified.payload)) as Catalog;

    expect(payload.version).toBe(1);
    expect(payload.packages).toEqual([]);
  });

  test("rejects a tampered catalogue", async () => {
    const { base, signed } = await start();
    const keys = (await (await fetch(`${base}/keys.json`)).json()) as { keys: JWK[] };
    const key = await importJWK(keys.keys[0] as JWK, "EdDSA");
    const tampered = `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`;

    await expect(compactVerify(tampered, key)).rejects.toThrow();
  });

  test("exposes the catalogue and inspector UI", async () => {
    const { base } = await start();

    expect(await (await fetch(`${base}/catalog.json`)).json()).toMatchObject({ packages: [] });
    expect(await (await fetch(`${base}/`)).text()).toContain("Marketplace mock");
  });

  test("serves signed theme packages, including one that fails the island check", async () => {
    const packages = await buildThemePackages();
    const catalog: Catalog = {
      version: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      packages: packages.map((entry) => entry.package),
    };
    const signed = await signCatalog(catalog);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: createMarketplaceHandler(catalog, signed, packages),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const keys = (await (await fetch(`${base}/keys.json`)).json()) as { keys: JWK[] };
    const key = await importJWK(keys.keys[0] as JWK, "EdDSA");
    const verified = await compactVerify(signed, key);
    const payload = JSON.parse(new TextDecoder().decode(verified.payload)) as Catalog;

    expect(payload.packages.map((entry) => entry.id).sort()).toEqual(["aurora", "broken-island"]);

    for (const entry of packages) {
      const bundle = new Uint8Array(
        await (await fetch(`${base}${entry.package.bundleUrl}`)).arrayBuffer(),
      );
      const signature = await (await fetch(`${base}${entry.package.signatureUrl}`)).text();

      expect(verifyThemeBundle(bundle, signature.trim(), keys.keys[0] as JWK)).toBe(true);
    }
  });
});

describe("marketplace plugin package", () => {
  test("serves a signed plugin bundle whose checksum and manifest are valid", async () => {
    const packages = await buildPluginPackages();
    const entry = packages.find((candidate) => candidate.package.id === "welcome-bot");

    if (entry === undefined) {
      throw new Error("missing plugin package");
    }

    expect(entry.package).toMatchObject({ id: "welcome-bot", type: "plugin", sdkMajor: 2 });
    expect(verifyThemeBundle(entry.bundle, entry.signature, DEV_THEME_PUBLIC_KEY)).toBe(true);

    if (entry.package.type === "plugin") {
      expect(createHash("sha256").update(entry.bundle).digest("hex")).toBe(entry.package.sha256);
    }

    const files = decodeThemeTar(entry.bundle);

    if (files === null) {
      throw new Error("bundle is not a valid tar");
    }

    const manifest = JSON.parse(new TextDecoder().decode(files.get("plugin.json")));
    expect(parsePluginManifest(manifest)).toMatchObject({
      id: "welcome-bot",
      capabilities: ["events", "jobs", "core.read", "db", "settings"],
    });
    expect(files.has("server.ts")).toBe(true);
    // The jail has no node_modules: the published entry must not import workspace packages.
    const entrySource = new TextDecoder().decode(files.get("server.ts"));
    expect(entrySource).not.toMatch(/from\s+["']@bulletin\//);
    expect(entrySource).toContain("welcome-bot");
  });

  test("publishes the marketplace-only topic-notice sample", async () => {
    const packages = await buildPluginPackages();
    expect(packages.map((entry) => entry.package.id).sort()).toEqual([
      "hide-post-count",
      "tip-jar",
      "topic-notice",
      "welcome-bot",
    ]);
  });
});

describe("sample plugin catalogs", () => {
  test("every shipped sample manifest validates against the SDK schema", async () => {
    const root = new URL("../plugins/", import.meta.url);
    const ids = ["hide-post-count", "welcome-bot", "tip-jar"];

    for (const id of ids) {
      const value = await Bun.file(new URL(`${id}/plugin.json`, root)).json();
      const manifest = parsePluginManifest(value);
      expect(manifest.id).toBe(id);

      if (id === "hide-post-count") {
        expect(manifest.templateFragments[0]?.body).toContain(
          ".bl-author-card__posts{display:none",
        );
      }
    }
  });
});
