import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  forumSeedModule,
  groupsSeedModule,
  membersSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import {
  createChildTheme,
  DEV_THEME_PRIVATE_KEY,
  DEV_THEME_PUBLIC_KEY,
  encodeThemeBundle,
  loadThemeResources,
  readThemeDetail,
  saveThemeCss,
  saveThemeStrings,
  saveThemeTemplate,
  saveThemeTokens,
  signThemeBundle,
  type ThemeBundleManifest,
} from "@bulletin/domain/themes";
import type { StorageClient } from "@bulletin/storage";
import { loadDefaultThemeTemplates, loadTheme } from "@bulletin/templates";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  exportThemeBundle,
  installMarketplaceTheme,
  installThemeBundle,
} from "../../apps/staff-api/src/theme-bundles.ts";
import {
  type Catalog,
  createMarketplaceHandler,
  signCatalog,
} from "../../mocks/marketplace/src/app.ts";
import { buildThemePackages } from "../../mocks/marketplace/src/packages.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function storageStub(): StorageClient & { readonly objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();

  return {
    objects,
    put: async (key: string, data: Uint8Array) => {
      objects.set(key, new Uint8Array(data));
      return data.byteLength;
    },
    get: async (key: string) => {
      const value = objects.get(key);

      if (value === undefined) {
        throw new Error("not found");
      }

      return value;
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  } as unknown as StorageClient & { readonly objects: Map<string, Uint8Array> };
}

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "theme_bundles" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        forumSeedModule,
        groupsSeedModule,
        membersSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.member_id;
}

async function themeId(database: TestDatabase, name: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.themes WHERE name = ${name}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing theme ${name}`);
  }

  return row.id;
}

function expectOk<T>(
  outcome: { readonly ok: true; readonly result: T } | { readonly ok: false },
): T {
  if (!outcome.ok) {
    throw new Error("Expected success");
  }

  return outcome.result;
}

async function signedManifest(
  manifest: ThemeBundleManifest,
): Promise<{ bundle: Uint8Array; signature: string }> {
  const bundle = encodeThemeBundle(manifest, new Map());
  return { bundle, signature: signThemeBundle(bundle, DEV_THEME_PRIVATE_KEY) };
}

integrationDescribe("theme bundles and distribution", () => {
  test("exports a resolved theme and imports it again from its signed bundle", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const parent = await themeId(database, "default");
      const child = expectOk(
        await createChildTheme(database.sql, {
          name: "roundtrip-theme",
          parentId: parent,
          actorId: admin,
        }),
      ).id;
      expectOk(
        await saveThemeTemplate(database.sql, {
          themeId: child,
          name: "footer",
          body: "<footer>round trip</footer>",
          actorId: admin,
        }),
      );
      expectOk(
        await saveThemeTokens(database.sql, {
          themeId: child,
          scheme: "light",
          tokens: { accent: "#123456" },
        }),
      );
      expectOk(await saveThemeCss(database.sql, { themeId: child, css: ".rt { color: red; }" }));
      expectOk(
        await saveThemeStrings(database.sql, {
          themeId: child,
          strings: [{ locale: "en", key: "theme.footer", value: "Round trip footer" }],
        }),
      );

      const storage = storageStub();
      const exported = await exportThemeBundle(database.sql, storage, child, DEV_THEME_PRIVATE_KEY);

      if (exported === null) {
        throw new Error("Expected an exported bundle");
      }

      expect(exported.filename).toMatch(/^roundtrip-theme-\d+\.tar$/);

      // Remove the source and reinstall from the signed bundle.
      await database.sql`DELETE FROM core.themes WHERE id = ${child}`;
      const imported = await installThemeBundle(
        database.sql,
        storage,
        admin,
        exported.bundle,
        exported.signature,
        DEV_THEME_PUBLIC_KEY,
        "upload",
      );

      expect(imported.ok).toBe(true);

      if (!imported.ok) {
        return;
      }

      const detail = await readThemeDetail(database.sql, imported.id);
      expect(detail?.templates.find((entry) => entry.name === "footer")?.body).toBe(
        "<footer>round trip</footer>",
      );
      expect(detail?.css).toContain(".rt");
      expect(detail?.strings).toEqual([
        { locale: "en", key: "theme.footer", value: "Round trip footer" },
      ]);

      const loaded = await loadTheme(database.sql, imported.id);
      const resources = await loadThemeResources(
        database.sql,
        loaded?.chain.map((entry) => entry.id) ?? [],
      );
      expect(resources.tokens.light.accent).toBe("#123456");
      expect(resources.strings.en["theme.footer"]).toBe("Round trip footer");
    });
  }, 60_000);

  test("refuses an unsigned or tampered bundle", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const storage = storageStub();
      const templates = await loadDefaultThemeTemplates();
      const manifest: ThemeBundleManifest = {
        format: "bulletin-theme",
        formatVersion: 1,
        name: "unsigned-theme",
        parent: null,
        description: "",
        version: 1,
        templates,
        tokens: { light: {}, dark: {} },
        css: "",
        strings: [],
        assets: [],
      };
      const { bundle, signature } = await signedManifest(manifest);

      expect(
        await installThemeBundle(
          database.sql,
          storage,
          admin,
          bundle,
          "",
          DEV_THEME_PUBLIC_KEY,
          "upload",
        ),
      ).toEqual({ ok: false, code: "invalid_signature" });

      const tampered = new Uint8Array(bundle);
      tampered[0] = (tampered[0] ?? 0) ^ 1;
      expect(
        await installThemeBundle(
          database.sql,
          storage,
          admin,
          tampered,
          signature,
          DEV_THEME_PUBLIC_KEY,
          "upload",
        ),
      ).toEqual({ ok: false, code: "invalid_signature" });
    });
  }, 60_000);

  test("refuses a topic template without the reply editor and a failing token contrast", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const storage = storageStub();
      const templates = await loadDefaultThemeTemplates();
      const topic = templates.topic ?? "";
      const base: ThemeBundleManifest = {
        format: "bulletin-theme",
        formatVersion: 1,
        name: "broken-theme",
        parent: "default",
        description: "",
        version: 1,
        templates: {
          topic: topic.replace(/\{%-?\s*island\s+"Editor"[^%]*%\}/g, ""),
        },
        tokens: { light: {}, dark: {} },
        css: "",
        strings: [],
        assets: [],
      };
      const broken = await signedManifest(base);
      const missing = await installThemeBundle(
        database.sql,
        storage,
        admin,
        broken.bundle,
        broken.signature,
        DEV_THEME_PUBLIC_KEY,
        "upload",
      );

      expect(missing).toMatchObject({ ok: false, code: "checks_failed" });

      if (!missing.ok) {
        expect(missing.issues).toEqual(
          expect.arrayContaining([{ code: "missing_island", template: "topic", island: "Editor" }]),
        );
      }

      const lowContrast = await signedManifest({
        ...base,
        name: "contrast-theme",
        templates: { footer: "<footer>ok</footer>" },
        tokens: { light: { bg: "#ffffff", accent: "#ffffff" }, dark: {} },
      });
      const contrast = await installThemeBundle(
        database.sql,
        storage,
        admin,
        lowContrast.bundle,
        lowContrast.signature,
        DEV_THEME_PUBLIC_KEY,
        "upload",
      );

      expect(contrast).toMatchObject({ ok: false, code: "checks_failed" });

      if (!contrast.ok) {
        expect(contrast.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "contrast" })]),
        );
      }
    });
  }, 60_000);

  test("installs a signed marketplace theme and refuses the failing package", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const storage = storageStub();
      const packages = await buildThemePackages();
      const catalog: Catalog = {
        version: 1,
        generatedAt: "2026-01-01T00:00:00.000Z",
        packages: packages.map((entry) => entry.package),
      };
      const signedCatalog = await signCatalog(catalog);
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: createMarketplaceHandler(catalog, signedCatalog, packages),
      });

      try {
        const baseUrl = `http://127.0.0.1:${server.port}`;
        const installed = await installMarketplaceTheme(database.sql, storage, admin, {
          baseUrl,
          packageId: "aurora",
          publicKey: DEV_THEME_PUBLIC_KEY,
        });

        expect(installed).toMatchObject({ ok: true });
        expect(
          (await readThemeDetail(database.sql, installed.ok ? installed.id : "0"))?.source,
        ).toBe("marketplace");

        const broken = await installMarketplaceTheme(database.sql, storage, admin, {
          baseUrl,
          packageId: "broken-island",
          publicKey: DEV_THEME_PUBLIC_KEY,
        });

        expect(broken).toMatchObject({ ok: false, code: "checks_failed" });
      } finally {
        server.stop(true);
      }
    });
  }, 60_000);
});
