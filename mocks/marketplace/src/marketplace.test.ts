import { afterEach, describe, expect, test } from "bun:test";
import { verifyThemeBundle } from "@bulletin/domain/themes";
import { compactVerify, importJWK, type JWK } from "jose";
import { type Catalog, createMarketplaceHandler, signCatalog } from "./app.ts";
import { buildThemePackages } from "./packages.ts";

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
