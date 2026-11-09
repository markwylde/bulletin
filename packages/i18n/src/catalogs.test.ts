import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildMergedCatalogs,
  type CatalogIssue,
  checkCatalogs,
  discoverCatalogs,
  formatCatalogIssues,
  validateCatalogs,
} from "./catalogs.ts";

const roots: string[] = [];

async function fixture(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bulletin-i18n-"));
  roots.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await Bun.write(
      fullPath,
      typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`,
    );
  }

  return root;
}

function codes(issues: readonly CatalogIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("catalog discovery", () => {
  test("reads app and package catalogs and rejects unknown locales", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { "topic.title": "Topic" },
      "packages/ui/i18n/fr.json": { "ui.button": "Bouton" },
      "packages/ui/i18n/de.json": { "ui.button": "Taste" },
    });

    const result = await discoverCatalogs(root);

    expect(
      result.sources.map((source) => `${source.kind}:${source.owner}:${source.locale}`),
    ).toEqual(["app:forum:en", "package:ui:fr"]);
    expect(codes(result.issues)).toEqual(["invalid_locale"]);
  });
});

describe("catalog completeness", () => {
  test("passes when every owner has all locales and every key is used", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { "topic.title": "Topic" },
      "apps/forum/i18n/es.json": { "topic.title": "Tema" },
      "apps/forum/i18n/fr.json": { "topic.title": "Sujet" },
      "apps/forum/src/page.ts": 't("topic.title");\n',
      "packages/ui/i18n/en.json": { "ui.button": "Reply" },
      "packages/ui/i18n/es.json": { "ui.button": "Responder" },
      "packages/ui/i18n/fr.json": { "ui.button": "Répondre" },
      "packages/ui/src/button.ts": 't("ui.button");\n',
    });

    const result = await checkCatalogs({ root });

    expect(result.issues).toEqual([]);
    expect(result.merged.forum?.en).toEqual({ "topic.title": "Topic", "ui.button": "Reply" });
    expect(result.merged.forum?.es).toEqual({ "topic.title": "Tema", "ui.button": "Responder" });
    expect(result.merged.forum?.fr).toEqual({ "topic.title": "Sujet", "ui.button": "Répondre" });
  });

  test("fails on a planted missing key and names the missing locales", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { "topic.title": "Topic", "topic.body": "Body" },
      "apps/forum/i18n/es.json": { "topic.title": "Tema" },
      "apps/forum/i18n/fr.json": { "topic.title": "Sujet" },
      "apps/forum/src/page.ts": 't("topic.title"); t("topic.body");\n',
    });

    const result = await checkCatalogs({ root });
    const missing = result.issues.find((issue) => issue.code === "missing_key");

    expect(missing).toMatchObject({
      key: "topic.body",
      missingLocales: ["es", "fr"],
    });
    expect(missing?.message).toContain("topic.body");
    expect(missing?.message).toContain("es, fr");
    expect(formatCatalogIssues(result.issues)).toContain("topic.body");
  });

  test("fails when a locale catalog file is missing", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { "topic.title": "Topic" },
      "apps/forum/src/page.ts": 't("topic.title");\n',
    });

    const result = await checkCatalogs({ root });

    expect(result.issues.filter((issue) => issue.code === "missing_catalog")).toHaveLength(2);
  });

  test("fails on invalid ICU syntax", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { "topic.count": "{count, plural, one {# topic}" },
      "apps/forum/i18n/es.json": { "topic.count": "{count, plural, one {# tema}" },
      "apps/forum/i18n/fr.json": { "topic.count": "{count, plural, one {# sujet}" },
      "apps/forum/src/page.ts": 't("topic.count");\n',
    });

    const result = await checkCatalogs({ root });

    expect(codes(result.issues)).toContain("invalid_catalog");
  });
});

describe("unused and duplicate keys", () => {
  test("fails on a key that no source references", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { "topic.title": "Topic", "topic.unused": "Unused" },
      "apps/forum/i18n/es.json": { "topic.title": "Tema", "topic.unused": "Sin usar" },
      "apps/forum/i18n/fr.json": { "topic.title": "Sujet", "topic.unused": "Inutilisé" },
      "apps/forum/src/page.ts": 't("topic.title");\n',
    });

    const result = await checkCatalogs({ root });

    expect(
      result.issues.filter((issue) => issue.code === "unused_key").map((issue) => issue.key),
    ).toEqual(["topic.unused"]);
  });

  test("recognises locale-first and bound translation calls", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { "topic.body": "Body", "topic.title": "Title" },
      "apps/forum/i18n/es.json": { "topic.body": "Cuerpo", "topic.title": "Título" },
      "apps/forum/i18n/fr.json": { "topic.body": "Corps", "topic.title": "Titre" },
      "apps/forum/src/page.ts":
        't("es", "topic.title");\nconst translate = useT();\ntranslate("topic.body");\n',
    });

    const result = await checkCatalogs({ root });

    expect(result.issues.filter((issue) => issue.code === "unused_key")).toEqual([]);
  });

  test("ignores test files, fixtures, comments and unrelated string literals", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": {
        "topic.commented": "Commented",
        "topic.fixture": "Fixture",
        "topic.string": "String",
        "topic.testonly": "Test",
      },
      "apps/forum/i18n/es.json": {
        "topic.commented": "Comentado",
        "topic.fixture": "Fixture",
        "topic.string": "Cadena",
        "topic.testonly": "Prueba",
      },
      "apps/forum/i18n/fr.json": {
        "topic.commented": "Commenté",
        "topic.fixture": "Fixture",
        "topic.string": "Chaîne",
        "topic.testonly": "Test",
      },
      "apps/forum/src/page.test.ts": 't("topic.testonly");\n',
      "apps/forum/fixtures/page.ts": 't("topic.fixture");\n',
      "apps/forum/src/page.ts":
        '// t("topic.commented")\n/* t("topic.commented") */\nconst note = "topic.string";\n',
    });

    const result = await checkCatalogs({ root });
    const unused = result.issues
      .filter((issue) => issue.code === "unused_key")
      .map((issue) => issue.key)
      .sort();

    expect(unused).toEqual(["topic.commented", "topic.fixture", "topic.string", "topic.testonly"]);
  });

  test("fails when an app and a package define the same key", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { "shared.title": "Topic" },
      "apps/forum/i18n/es.json": { "shared.title": "Tema" },
      "apps/forum/i18n/fr.json": { "shared.title": "Sujet" },
      "packages/ui/i18n/en.json": { "shared.title": "Topic" },
      "packages/ui/i18n/es.json": { "shared.title": "Tema" },
      "packages/ui/i18n/fr.json": { "shared.title": "Sujet" },
      "apps/forum/src/page.ts": 't("shared.title");\n',
    });

    const result = await checkCatalogs({ root });

    expect(result.issues.filter((issue) => issue.code === "duplicate_key")).toHaveLength(3);
  });
});

describe("merged catalogs", () => {
  test("validateCatalogs reports every missing key per owner", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { a: "A", b: "B" },
      "packages/ui/i18n/en.json": { a: "A" },
    });
    const { sources } = await discoverCatalogs(root);

    const issues = validateCatalogs(sources);

    expect(issues.filter((issue) => issue.code === "missing_key")).toHaveLength(3);
  });

  test("merges package catalogs into each app", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { "app.key": "App" },
      "packages/ui/i18n/en.json": { "ui.key": "UI" },
    });
    const { sources } = await discoverCatalogs(root);

    const { merged, issues } = buildMergedCatalogs(sources);

    expect(merged.forum?.en).toEqual({ "app.key": "App", "ui.key": "UI" });
    expect(issues).toEqual([]);
  });

  test("fails when the checked-in merged app catalogs are stale", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { "app.key": "App" },
      "apps/forum/i18n/es.json": { "app.key": "Aplicación" },
      "apps/forum/i18n/fr.json": { "app.key": "Application" },
      "apps/forum/src/page.ts": 't("app.key");\n',
    });

    const result = await checkCatalogs({ root, requireMerged: true });

    expect(result.issues.filter((issue) => issue.code === "stale_merged")).toHaveLength(3);
  });
});
