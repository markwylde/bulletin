import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertValidMessage,
  type Catalog,
  isLocale,
  LOCALES,
  type Locale,
  loadCatalog,
} from "./catalog.ts";

export interface CatalogSource {
  readonly kind: "app" | "package";
  readonly owner: string;
  readonly locale: Locale;
  readonly path: string;
  readonly catalog: Catalog;
}

export type CatalogIssueCode =
  | "invalid_catalog"
  | "invalid_locale"
  | "duplicate_key"
  | "missing_catalog"
  | "missing_key"
  | "unused_key";

export interface CatalogIssue {
  readonly code: CatalogIssueCode;
  readonly message: string;
  readonly path?: string;
  readonly key?: string;
  readonly locale?: Locale;
  readonly missingLocales?: readonly Locale[];
}

export interface MergedCatalogs {
  readonly [app: string]: Readonly<Record<Locale, Catalog>>;
}

export interface CatalogCheckResult {
  readonly sources: readonly CatalogSource[];
  readonly issues: readonly CatalogIssue[];
  readonly merged: MergedCatalogs;
}

export interface CatalogCheckOptions {
  /** Repository root. */
  readonly root: string;
  /** Write the merged per-app catalogs after a successful check. */
  readonly write?: boolean;
}

const CATALOG_GLOBS = ["apps/*/i18n/*.json", "packages/*/i18n/*.json"] as const;
const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mts,cts,astro,liquid}";
const IGNORED_DIRECTORIES = new Set([
  ".astro",
  ".claude",
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

function sortedCatalog(catalog: Catalog): Catalog {
  const entries = Object.entries(catalog).sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function ownerKey(source: Pick<CatalogSource, "kind" | "owner">): string {
  return `${source.kind}:${source.owner}`;
}

function readPathParts(path: string): {
  kind: CatalogSource["kind"];
  owner: string;
  localeFile: string;
} {
  const parts = path.split("/");

  if (parts.length !== 4 || (parts[0] !== "apps" && parts[0] !== "packages")) {
    throw new Error(`Unexpected catalog path: ${path}`);
  }

  return {
    kind: parts[0] === "apps" ? "app" : "package",
    owner: parts[1] as string,
    localeFile: parts[3] as string,
  };
}

export async function discoverCatalogs(
  root: string,
): Promise<{ sources: CatalogSource[]; issues: CatalogIssue[] }> {
  const sources: CatalogSource[] = [];
  const issues: CatalogIssue[] = [];
  const paths: string[] = [];

  for (const pattern of CATALOG_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      paths.push(path.replaceAll("\\", "/"));
    }
  }

  paths.sort();

  for (const path of paths) {
    const { kind, owner, localeFile } = readPathParts(path);
    const rawLocale = localeFile.replace(/\.json$/, "");

    if (!isLocale(rawLocale)) {
      issues.push({
        code: "invalid_locale",
        message: `${path}: unsupported locale "${rawLocale}" (expected ${LOCALES.join(", ")})`,
        path,
      });
      continue;
    }

    try {
      const catalog = await loadCatalog(join(root, path));
      sources.push({ kind, owner, locale: rawLocale, path, catalog });
    } catch (error) {
      issues.push({
        code: "invalid_catalog",
        message: `${path}: ${error instanceof Error ? error.message : String(error)}`,
        path,
      });
    }
  }

  return { sources, issues };
}

/** Checks every key exists in every shipped locale and that its ICU syntax parses. */
export function validateCatalogs(sources: readonly CatalogSource[]): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const groups = new Map<
    string,
    { kind: CatalogSource["kind"]; owner: string; catalogs: Map<Locale, CatalogSource> }
  >();

  for (const source of sources) {
    const key = ownerKey(source);
    const group = groups.get(key) ?? {
      kind: source.kind,
      owner: source.owner,
      catalogs: new Map<Locale, CatalogSource>(),
    };
    group.catalogs.set(source.locale, source);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    for (const locale of LOCALES) {
      const source = group.catalogs.get(locale);

      if (source === undefined) {
        issues.push({
          code: "missing_catalog",
          message: `${group.kind}/${group.owner}: missing ${locale}.json catalog`,
          locale,
        });
        continue;
      }

      for (const [key, message] of Object.entries(source.catalog)) {
        try {
          assertValidMessage(locale, message);
        } catch (error) {
          issues.push({
            code: "invalid_catalog",
            path: source.path,
            key,
            locale,
            message: `${source.path}: "${key}": invalid ICU message (${
              error instanceof Error ? error.message : String(error)
            })`,
          });
        }
      }
    }

    const keys = new Set<string>();
    for (const source of group.catalogs.values()) {
      for (const key of Object.keys(source.catalog)) {
        keys.add(key);
      }
    }

    for (const key of [...keys].sort()) {
      const missing = LOCALES.filter(
        (locale) => group.catalogs.get(locale)?.catalog[key] === undefined,
      );

      if (missing.length > 0) {
        issues.push({
          code: "missing_key",
          key,
          missingLocales: missing,
          message: `${group.kind}/${group.owner}: "${key}" is missing in ${missing.join(", ")}`,
        });
      }
    }
  }

  return issues;
}

export function unusedKeyIssues(
  sources: readonly CatalogSource[],
  unusedKeys: ReadonlySet<string>,
): CatalogIssue[] {
  const firstSource = new Map<string, string>();

  for (const source of sources) {
    for (const key of Object.keys(source.catalog)) {
      if (!firstSource.has(key)) {
        firstSource.set(key, source.path);
      }
    }
  }

  return [...firstSource.entries()]
    .filter(([key]) => unusedKeys.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, path]) => ({
      code: "unused_key" as const,
      key,
      path,
      message: `"${key}" is defined in ${path} but never used`,
    }));
}

export function buildMergedCatalogs(sources: readonly CatalogSource[]): {
  merged: MergedCatalogs;
  issues: CatalogIssue[];
} {
  const apps = sources.filter((source) => source.kind === "app");
  const packages = sources.filter((source) => source.kind === "package");
  const issues: CatalogIssue[] = [];
  const merged: Record<string, Readonly<Record<Locale, Catalog>>> = {};

  for (const app of new Set(apps.map((source) => source.owner))) {
    const byLocale = {} as Record<Locale, Catalog>;

    for (const locale of LOCALES) {
      const layers = [
        ...packages.filter((source) => source.locale === locale),
        ...apps.filter((source) => source.owner === app && source.locale === locale),
      ].sort((left, right) => left.path.localeCompare(right.path));

      const result: Record<string, string> = {};
      const origins = new Map<string, string>();

      for (const layer of layers) {
        for (const [key, message] of Object.entries(layer.catalog)) {
          const previous = origins.get(key);

          if (previous !== undefined) {
            issues.push({
              code: "duplicate_key",
              key,
              locale,
              path: layer.path,
              message: `${layer.path}: "${key}" also comes from ${previous}`,
            });
            continue;
          }

          origins.set(key, layer.path);
          result[key] = message;
        }
      }

      byLocale[locale] = sortedCatalog(result);
    }

    merged[app] = byLocale;
  }

  return { merged, issues };
}

async function scanSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  for await (const path of new Bun.Glob(SOURCE_GLOB).scan({ cwd: root, onlyFiles: true })) {
    const normalised = path.replaceAll("\\", "/");

    if (normalised.split("/").some((part) => IGNORED_DIRECTORIES.has(part))) {
      continue;
    }

    files.push(join(root, normalised));
  }

  return files;
}

function referencesKey(source: string, key: string): boolean {
  return (
    source.includes(`"${key}"`) || source.includes(`'${key}'`) || source.includes(`\`${key}\``)
  );
}

/** Returns the subset of keys that do not appear in application, package or test sources. */
export async function findUnusedKeysInSources(
  root: string,
  keys: Iterable<string>,
): Promise<ReadonlySet<string>> {
  const remaining = new Set(keys);
  const files = await scanSourceFiles(root);

  for (const file of files) {
    if (remaining.size === 0) {
      break;
    }

    const source = await Bun.file(file).text();

    for (const key of [...remaining]) {
      if (referencesKey(source, key)) {
        remaining.delete(key);
      }
    }
  }

  return new Set(remaining);
}

async function writeMergedCatalogs(root: string, merged: MergedCatalogs): Promise<void> {
  for (const [app, catalogs] of Object.entries(merged)) {
    for (const locale of LOCALES) {
      const path = join(root, "apps", app, "i18n", "merged", `${locale}.json`);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, `${JSON.stringify(catalogs[locale], null, 2)}\n`);
    }
  }
}

export async function checkCatalogs(options: CatalogCheckOptions): Promise<CatalogCheckResult> {
  const discovered = await discoverCatalogs(options.root);
  const validation = validateCatalogs(discovered.sources);
  const built = buildMergedCatalogs(discovered.sources);
  const keys = new Set(discovered.sources.flatMap((source) => Object.keys(source.catalog)));
  const unused = unusedKeyIssues(
    discovered.sources,
    await findUnusedKeysInSources(options.root, keys),
  );
  const issues = [...discovered.issues, ...validation, ...built.issues, ...unused];

  if (options.write === true && issues.length === 0) {
    await writeMergedCatalogs(options.root, built.merged);
  }

  return { sources: discovered.sources, issues, merged: built.merged };
}

export function formatCatalogIssues(issues: readonly CatalogIssue[]): string {
  return issues.map((issue) => `i18n: ${issue.message}`).join("\n");
}
