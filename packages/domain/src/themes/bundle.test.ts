import { describe, expect, test } from "bun:test";
import {
  decodeThemeBundle,
  encodeThemeBundle,
  encodeThemeTar,
  parseThemeBundleManifest,
  type ThemeBundleManifest,
} from "./bundle.ts";
import {
  DEV_THEME_PRIVATE_KEY,
  DEV_THEME_PUBLIC_KEY,
  signThemeBundle,
  verifyThemeBundle,
} from "./signing.ts";

const manifest: ThemeBundleManifest = {
  format: "bulletin-theme",
  formatVersion: 1,
  name: "bundle-test",
  parent: null,
  description: "A test theme",
  version: 3,
  templates: { footer: "<footer>{{ year }}</footer>" },
  tokens: { light: { accent: "#3157c7" }, dark: { accent: "#7f9cf5" } },
  css: ".logo { color: red; }",
  strings: [{ locale: "en", key: "theme.footer", value: "Hello" }],
  assets: [{ name: "logo.png", contentType: "image/png", file: "assets/logo.png" }],
};

describe("theme bundle", () => {
  test("round-trips the manifest and binary assets", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const bundle = encodeThemeBundle(manifest, new Map([["logo.png", bytes]]));
    const decoded = decodeThemeBundle(bundle);

    expect(decoded?.manifest).toEqual(manifest);
    expect([...(decoded?.assets.get("logo.png") ?? [])]).toEqual([1, 2, 3, 4, 5]);
  });

  test("rejects traversal and missing assets", () => {
    const bundle = encodeThemeTar([
      {
        name: "theme.json",
        data: new TextEncoder().encode(JSON.stringify({ ...manifest, assets: [] })),
      },
      { name: "../escape", data: new Uint8Array([1]) },
    ]);

    expect(decodeThemeBundle(bundle)).toBeNull();
    expect(() => encodeThemeBundle(manifest, new Map())).toThrow();
  });

  test("validates the manifest format and names", () => {
    expect(parseThemeBundleManifest(manifest)).toEqual(manifest);
    expect(parseThemeBundleManifest({ ...manifest, format: "other" })).toBeNull();
    expect(parseThemeBundleManifest({ ...manifest, name: "Bad Theme" })).toBeNull();
    expect(
      parseThemeBundleManifest({ ...manifest, assets: [{ ...manifest.assets[0], file: "x" }] }),
    ).toBeNull();
  });

  test("signs the exact bytes with Ed25519 and rejects tampering", () => {
    const bundle = encodeThemeBundle(manifest, new Map([["logo.png", new Uint8Array([1])]]));
    const signature = signThemeBundle(bundle, DEV_THEME_PRIVATE_KEY);

    expect(verifyThemeBundle(bundle, signature, DEV_THEME_PUBLIC_KEY)).toBe(true);
    expect(verifyThemeBundle(bundle, `${signature}A`, DEV_THEME_PUBLIC_KEY)).toBe(false);

    const tampered = new Uint8Array(bundle);
    tampered[tampered.length - 2] = 1;
    expect(verifyThemeBundle(tampered, signature, DEV_THEME_PUBLIC_KEY)).toBe(false);
  });
});
