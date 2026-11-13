import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CompactSign, importJWK } from "jose";
import { DEV_PRIVATE_KEY, DEV_PUBLIC_KEY } from "../../../../mocks/marketplace/src/keys.ts";
import {
  CatalogError,
  downloadVerifiedBundle,
  fetchCatalog,
  parsePluginCatalog,
  reviewCapabilities,
  verifyCatalogJws,
} from "./catalog.ts";

const PLUGIN = {
  id: "welcome-bot",
  type: "plugin" as const,
  name: "Welcome bot",
  version: "1.2.0",
  description: "Welcomes new members",
  author: "Bulletin",
  sdkVersion: "^2.0.0",
  sdkMajor: 2,
  capabilities: ["events", "core.read"],
  bundleUrl: "/packages/welcome-bot.tar",
  signatureUrl: "/packages/welcome-bot.sig",
  sha256: "a".repeat(64),
};

async function signedCatalog(packages: readonly unknown[]): Promise<string> {
  const key = await importJWK(DEV_PRIVATE_KEY, "EdDSA");
  return new CompactSign(
    new TextEncoder().encode(
      JSON.stringify({ version: 1, generatedAt: "2026-01-01T00:00:00Z", packages }),
    ),
  )
    .setProtectedHeader({ alg: "EdDSA", kid: "bulletin-marketplace-dev" })
    .sign(key);
}

describe("plugin marketplace catalog", () => {
  test("verifies the signed catalog and marks compatibility", async () => {
    const jws = await signedCatalog([
      PLUGIN,
      { ...PLUGIN, id: "future", sdkVersion: "^3.0.0", sdkMajor: 3 },
      { ...PLUGIN, id: "aurora", type: "theme" },
    ]);
    const catalog = await verifyCatalogJws(jws, [DEV_PUBLIC_KEY]);

    expect(catalog.packages.map((entry) => entry.id)).toEqual(["welcome-bot", "future"]);
    const entries = await fetchCatalog({
      baseUrl: "http://marketplace",
      fetch: async (url) =>
        url.endsWith("/keys.json") ? Response.json({ keys: [DEV_PUBLIC_KEY] }) : new Response(jws),
    });

    expect(entries[0]).toMatchObject({
      id: "welcome-bot",
      compatibility: { compatible: true, deprecated: false },
      installable: true,
    });
    expect(entries[1]).toMatchObject({
      id: "future",
      installable: false,
      compatibility: { compatible: false },
    });
  });

  test("rejects a tampered catalog", async () => {
    const jws = await signedCatalog([PLUGIN]);
    const tampered = `${jws.slice(0, -4)}AAAA`;

    await expect(verifyCatalogJws(tampered, [DEV_PUBLIC_KEY])).rejects.toMatchObject({
      code: "signature",
    });
  });

  test("rejects malformed plugin entries", () => {
    expect(() => parsePluginCatalog({ packages: [{ ...PLUGIN, sha256: "no" }] })).toThrow(
      CatalogError,
    );
  });
});

describe("bundle verification", () => {
  const bytes = new TextEncoder().encode("plugin bundle bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const entry = { ...PLUGIN, sha256 };

  test("refuses a bundle whose checksum does not match the catalog", async () => {
    await expect(
      downloadVerifiedBundle({
        entry: { ...entry, sha256: "b".repeat(64) },
        keys: [DEV_PUBLIC_KEY],
        fetch: async (url) => (url.endsWith(".sig") ? new Response("sig") : new Response(bytes)),
      }),
    ).rejects.toMatchObject({ code: "checksum" });
  });

  test("downloads when checksum and signature match", async () => {
    const { signThemeBundle } = await import("../themes/signing.ts");
    const signature = signThemeBundle(bytes, DEV_PRIVATE_KEY);
    const bundle = await downloadVerifiedBundle({
      entry,
      keys: [DEV_PUBLIC_KEY],
      fetch: async (url) => (url.endsWith(".sig") ? new Response(signature) : new Response(bytes)),
    });
    expect(new TextDecoder().decode(bundle)).toBe("plugin bundle bytes");
  });
});

describe("capability review", () => {
  test("lists plain-language capabilities, elevated access and egress hosts", () => {
    const review = reviewCapabilities(["events", "core.read", "pii"], ["api.example.com"]);
    expect(review).toEqual([
      { capability: "events", labelKey: "staff.plugins.capability.events", elevated: false },
      { capability: "core.read", labelKey: "staff.plugins.capability.core_read", elevated: true },
      { capability: "pii", labelKey: "staff.plugins.capability.pii", elevated: true },
      {
        capability: "egress:api.example.com",
        labelKey: "staff.plugins.capability.egressHost",
        elevated: false,
      },
    ]);
  });
});
