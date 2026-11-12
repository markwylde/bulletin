import {
  assertValidMessage,
  formatMessage,
  isLocale,
  type Locale,
  type Translator,
} from "@bulletin/i18n";
import type { SQL } from "bun";

export type ThemeSource = "core" | "marketplace" | "upload" | "custom";

export interface ThemeSummary {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly parentName: string | null;
  readonly version: number;
  readonly source: ThemeSource;
  readonly description: string;
  readonly templateCount: number;
  readonly childCount: number;
  readonly updatedAt: Date;
}

export interface ThemeTemplateView {
  readonly name: string;
  /** The resolved body the renderer currently uses (the theme's own or an ancestor's). */
  readonly body: string;
  readonly version: number;
  /** The ancestor providing this body, or null when the theme itself overrides it. */
  readonly inheritedFrom: string | null;
  /** The parent's body, for a side-by-side/diff editor. */
  readonly parentBody: string | null;
  readonly parentVersion: number | null;
  readonly canRevert: boolean;
}

export interface ThemeTemplateVersion {
  readonly name: string;
  readonly version: number;
  readonly body: string;
  readonly updatedBy: string | null;
  readonly createdAt: Date;
}

export interface ThemeTokenRecord {
  readonly scheme: "light" | "dark";
  readonly tokens: Readonly<Record<string, string>>;
}

export interface ThemeAssetRecord {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: number;
  /** The theme that owns the asset; inherited assets keep the ancestor's id. */
  readonly themeId: string;
  readonly themeName: string;
  readonly storageKey: string;
}

export interface ThemeStringRecord {
  readonly locale: Locale;
  readonly key: string;
  readonly value: string;
}

export interface ThemeDetail {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly parentName: string | null;
  readonly version: number;
  readonly source: ThemeSource;
  readonly description: string;
  readonly editable: boolean;
  readonly templates: readonly ThemeTemplateView[];
  readonly versions: readonly ThemeTemplateVersion[];
  readonly tokens: readonly ThemeTokenRecord[];
  readonly css: string;
  readonly assets: readonly ThemeAssetRecord[];
  readonly strings: readonly ThemeStringRecord[];
}

export interface ThemeResources {
  readonly tokens: Readonly<Record<"light" | "dark", Readonly<Record<string, string>>>>;
  readonly css: string;
  readonly assets: readonly ThemeAssetRecord[];
  readonly strings: Readonly<Record<Locale, Readonly<Record<string, string>>>>;
}

export interface ThemeMutationResult<T> {
  readonly ok: true;
  readonly result: T;
}
export type ThemeMutation<T> =
  | ThemeMutationResult<T>
  | { readonly ok: false; readonly code: ThemeErrorCode };

export type ThemeErrorCode =
  | "not_found"
  | "invalid_name"
  | "invalid_theme"
  | "invalid_scheme"
  | "invalid_locale"
  | "invalid_key"
  | "protected_theme"
  | "duplicate_name"
  | "unknown_version";

const THEME_NAME = /^[a-z][a-z0-9_-]{0,60}$/;
const TEMPLATE_NAME = /^[a-z][a-z0-9_.-]{0,80}$/;
const TOKEN_NAME = /^[a-z][a-z0-9-]{0,50}$/;
const STRING_KEY = /^[A-Za-z0-9_.-]{1,160}$/;
const HEX_COLOUR = /^#[\da-f]{6}$/i;

export function validThemeName(value: unknown): string | null {
  return typeof value === "string" && THEME_NAME.test(value) ? value : null;
}

export function validTemplateName(value: unknown): string | null {
  return typeof value === "string" && TEMPLATE_NAME.test(value) ? value : null;
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceOf(value: string): ThemeSource {
  return value === "core" || value === "marketplace" || value === "upload" ? value : "custom";
}

function tokensOf(value: unknown): Record<string, string> {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;

  if (!isRecord(parsed)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, token]) =>
      TOKEN_NAME.test(key) && typeof token === "string" && token.trim() !== ""
        ? [[key, token.trim()]]
        : [],
    ),
  );
}

export function isTokenScheme(value: unknown): value is "light" | "dark" {
  return value === "light" || value === "dark";
}

export interface TokenInput {
  readonly scheme: "light" | "dark";
  readonly tokens: Readonly<Record<string, string>>;
}

/**
 * Theme tokens become CSS custom properties, so a token is either a colour or a short CSS
 * value. Length limits keep a theme from smuggling an entire stylesheet through a token.
 */
export function validateTokenInput(value: unknown): TokenInput | null {
  if (!isRecord(value) || !isTokenScheme(value.scheme) || !isRecord(value.tokens)) {
    return null;
  }

  const tokens: Record<string, string> = {};

  for (const [key, token] of Object.entries(value.tokens)) {
    if (!TOKEN_NAME.test(key) || typeof token !== "string") {
      return null;
    }

    const trimmed = token.trim();

    // Empty means "inherit this token": leaving it out removes the override.
    if (trimmed === "") {
      continue;
    }

    if (trimmed.length > 120 || /[;{}<>]/.test(trimmed) || /url\s*\(/i.test(trimmed)) {
      return null;
    }

    tokens[key] = trimmed;
  }

  return { scheme: value.scheme, tokens };
}

/** A token value safe to write into a CSS custom property declaration. */
export function isSafeTokenValue(value: string): boolean {
  return value.length <= 120 && !/[;{}<>]/.test(value) && !/url\s*\(/i.test(value);
}

export function isHexColour(value: string): boolean {
  return HEX_COLOUR.test(value);
}

interface ChainTheme {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly depth: number;
}

/** One theme first, then each ancestor, stopping on a corrupted parent cycle. */
async function themeChain(sql: SQL, themeId: string): Promise<readonly ChainTheme[]> {
  return (await sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, name, parent_id, 0 AS depth, ARRAY[id] AS path
      FROM core.themes
      WHERE id::text = ${themeId}
      UNION ALL
      SELECT child.id, child.name, child.parent_id, ancestor.depth + 1,
        ancestor.path || child.id
      FROM core.themes AS child
      JOIN ancestors AS ancestor ON child.id = ancestor.parent_id
      WHERE NOT child.id = ANY(ancestor.path)
    )
    SELECT id::text AS id, name, parent_id::text AS parent_id, depth
    FROM ancestors
    ORDER BY depth
  `) as ChainTheme[];
}

interface ThemeRow {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly parent_name: string | null;
  readonly version: number;
  readonly source: string;
  readonly description: string;
  readonly updated_at: Date;
  readonly template_count: number;
  readonly child_count: number;
}

export async function listThemes(sql: SQL): Promise<readonly ThemeSummary[]> {
  const rows = (await sql`
    SELECT t.id::text AS id, t.name, t.parent_id::text AS parent_id, p.name AS parent_name,
      t.version, t.source, t.description, t.updated_at,
      (SELECT count(*)::int FROM core.theme_templates tt WHERE tt.theme_id = t.id)
        AS template_count,
      (SELECT count(*)::int FROM core.themes c WHERE c.parent_id = t.id) AS child_count
    FROM core.themes t
    LEFT JOIN core.themes p ON p.id = t.parent_id
    ORDER BY t.name
  `) as ThemeRow[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    parentName: row.parent_name,
    version: row.version,
    source: sourceOf(row.source),
    description: row.description,
    templateCount: row.template_count,
    childCount: row.child_count,
    updatedAt: row.updated_at,
  }));
}

interface DetailRow {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly parent_name: string | null;
  readonly version: number;
  readonly source: string;
  readonly description: string;
}

async function themeRow(sql: SQL, themeId: string): Promise<DetailRow | null> {
  const [row] = (await sql`
    SELECT t.id::text AS id, t.name, t.parent_id::text AS parent_id, p.name AS parent_name,
      t.version, t.source, t.description
    FROM core.themes t
    LEFT JOIN core.themes p ON p.id = t.parent_id
    WHERE t.id::text = ${themeId}
  `) as DetailRow[];

  return row ?? null;
}

interface OwnTemplateRow {
  readonly name: string;
  readonly body: string;
  readonly version: number;
}

interface OwnTokenRow {
  readonly scheme: string;
  readonly tokens: unknown;
}

interface OwnStringRow {
  readonly locale: string;
  readonly key: string;
  readonly value: string;
}

interface AssetRow {
  readonly id: string;
  readonly theme_id: string;
  readonly theme_name: string;
  readonly name: string;
  readonly content_type: string;
  readonly bytes: number;
  readonly storage_key: string;
}

interface VersionRow {
  readonly name: string;
  readonly version: number;
  readonly body: string;
  readonly updated_by: string | null;
  readonly created_at: Date;
}

function assetView(row: AssetRow): ThemeAssetRecord {
  return {
    id: row.id,
    name: row.name,
    contentType: row.content_type,
    bytes: row.bytes,
    themeId: row.theme_id,
    themeName: row.theme_name,
    storageKey: row.storage_key,
  };
}

/** One theme with its own rows and the resolved inheritance chain, for the staff editor. */
export async function readThemeDetail(sql: SQL, themeId: string): Promise<ThemeDetail | null> {
  const id = idOf(themeId);

  if (id === null) {
    return null;
  }

  const row = await themeRow(sql, id);

  if (row === null) {
    return null;
  }

  const [ownTemplates, tokens, cssRow, ownStrings, versions, assets] = await Promise.all([
    sql`
      SELECT name, body, version FROM core.theme_templates
      WHERE theme_id = ${row.id} ORDER BY name
    ` as Promise<OwnTemplateRow[]>,
    sql`
      SELECT scheme, tokens FROM core.theme_tokens
      WHERE theme_id = ${row.id} ORDER BY scheme
    ` as Promise<OwnTokenRow[]>,
    sql`
      SELECT css FROM core.theme_css WHERE theme_id = ${row.id}
    ` as Promise<Array<{ css: string }>>,
    sql`
      SELECT locale, key, value FROM core.theme_strings
      WHERE theme_id = ${row.id} ORDER BY locale, key
    ` as Promise<OwnStringRow[]>,
    sql`
      SELECT name, version, body, updated_by::text AS updated_by, created_at
      FROM core.theme_template_versions
      WHERE theme_id = ${row.id}
      ORDER BY name, version DESC
    ` as Promise<VersionRow[]>,
    sql`
      SELECT a.id::text AS id, a.theme_id::text AS theme_id, t.name AS theme_name,
        a.name, a.content_type, a.bytes, a.storage_key
      FROM core.theme_assets a
      JOIN core.themes t ON t.id = a.theme_id
      WHERE a.theme_id = ${row.id}
      ORDER BY a.name
    ` as Promise<AssetRow[]>,
  ]);
  const chain = await themeChain(sql, row.id);
  const chainIds = chain.map((entry) => entry.id);
  const chainRows = (await sql`
    SELECT theme_id::text AS theme_id, name, body, version
    FROM core.theme_templates
    WHERE theme_id = ANY(${`{${chainIds.join(",")}}`}::bigint[])
    ORDER BY name
  `) as Array<{ theme_id: string; name: string; body: string; version: number }>;
  const depth = new Map(chain.map((entry) => [entry.id, entry.depth]));
  const names = new Map(chain.map((entry) => [entry.id, entry.name]));
  const byName = new Map<
    string,
    Array<{ themeId: string; themeName: string; body: string; version: number }>
  >();

  for (const template of [...chainRows].sort(
    (left, right) => (depth.get(left.theme_id) ?? 0) - (depth.get(right.theme_id) ?? 0),
  )) {
    const list = byName.get(template.name) ?? [];
    list.push({
      themeId: template.theme_id,
      themeName: names.get(template.theme_id) ?? "",
      body: template.body,
      version: template.version,
    });
    byName.set(template.name, list);
  }

  const own = new Map(ownTemplates.map((template) => [template.name, template]));
  const parentByName = new Map<string, { body: string; version: number }>();

  if (row.parent_id !== null) {
    const parentChain = await themeChain(sql, row.parent_id);
    const parentIds = parentChain.map((entry) => entry.id);
    const parentDepth = new Map(parentChain.map((entry) => [entry.id, entry.depth]));
    const parentRows = (await sql`
      SELECT theme_id::text AS theme_id, name, body, version
      FROM core.theme_templates
      WHERE theme_id = ANY(${`{${parentIds.join(",")}}`}::bigint[])
    `) as Array<{ theme_id: string; name: string; body: string; version: number }>;

    for (const template of [...parentRows].sort(
      (left, right) =>
        (parentDepth.get(left.theme_id) ?? 0) - (parentDepth.get(right.theme_id) ?? 0),
    )) {
      parentByName.set(template.name, { body: template.body, version: template.version });
    }
  }

  const templates: ThemeTemplateView[] = [];

  for (const [name, candidates] of [...byName.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const first = candidates[0];

    if (first === undefined) {
      continue;
    }

    const parent = parentByName.get(name) ?? null;
    const ownTemplate = own.get(name) ?? null;

    templates.push({
      name,
      body: first.body,
      version: first.version,
      inheritedFrom: first.themeId === row.id ? null : first.themeName,
      parentBody: parent?.body ?? null,
      parentVersion: parent?.version ?? null,
      canRevert: ownTemplate !== null && row.parent_id !== null,
    });
  }

  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    parentName: row.parent_name,
    version: row.version,
    source: sourceOf(row.source),
    description: row.description,
    editable: row.source !== "core",
    templates,
    versions: versions.map((version) => ({
      name: version.name,
      version: version.version,
      body: version.body,
      updatedBy: version.updated_by,
      createdAt: version.created_at,
    })),
    tokens: tokens.flatMap((entry) =>
      isTokenScheme(entry.scheme) ? [{ scheme: entry.scheme, tokens: tokensOf(entry.tokens) }] : [],
    ),
    css: cssRow[0]?.css ?? "",
    assets: assets.map(assetView),
    strings: ownStrings.flatMap((entry) =>
      isLocale(entry.locale) ? [{ locale: entry.locale, key: entry.key, value: entry.value }] : [],
    ),
  };
}

/**
 * Loads the theme's ancestor chain and merges tokens, CSS, assets and string overrides. A
 * child overrides what it defines and inherits every other piece (ADR 0008).
 */
export async function loadThemeResources(
  sql: SQL,
  themeIds: readonly string[],
): Promise<ThemeResources> {
  const ids = [...themeIds];
  const idList = `{${ids.join(",")}}`;

  const [tokenRows, cssRows, assetRows, stringRows] = await Promise.all([
    sql`
      SELECT theme_id::text AS theme_id, scheme, tokens
      FROM core.theme_tokens
      WHERE theme_id = ANY(${idList}::bigint[])
      ORDER BY scheme
    ` as Promise<Array<{ theme_id: string; scheme: string; tokens: unknown }>>,
    sql`
      SELECT theme_id::text AS theme_id, css
      FROM core.theme_css
      WHERE theme_id = ANY(${idList}::bigint[])
    ` as Promise<Array<{ theme_id: string; css: string }>>,
    sql`
      SELECT a.id::text AS id, a.theme_id::text AS theme_id, t.name AS theme_name,
        a.name, a.content_type, a.bytes, a.storage_key
      FROM core.theme_assets a
      JOIN core.themes t ON t.id = a.theme_id
      WHERE a.theme_id = ANY(${idList}::bigint[])
    ` as Promise<AssetRow[]>,
    sql`
      SELECT theme_id::text AS theme_id, locale, key, value
      FROM core.theme_strings
      WHERE theme_id = ANY(${idList}::bigint[])
    ` as Promise<Array<{ theme_id: string; locale: string; key: string; value: string }>>,
  ]);
  const depth = new Map(ids.map((id, index) => [id, index]));
  const tokens: Record<"light" | "dark", Record<string, string>> = { light: {}, dark: {} };

  for (const entry of [...tokenRows].sort(
    (left, right) => (depth.get(left.theme_id) ?? 0) - (depth.get(right.theme_id) ?? 0),
  )) {
    if (!isTokenScheme(entry.scheme)) {
      continue;
    }

    for (const [key, value] of Object.entries(tokensOf(entry.tokens))) {
      tokens[entry.scheme][key] ??= value;
    }
  }

  const css =
    [...cssRows]
      .sort((left, right) => (depth.get(left.theme_id) ?? 0) - (depth.get(right.theme_id) ?? 0))
      .find((entry) => entry.css.trim() !== "")?.css ?? "";
  const assetsByName = new Map<string, ThemeAssetRecord>();

  for (const asset of [...assetRows].sort(
    (left, right) => (depth.get(left.theme_id) ?? 0) - (depth.get(right.theme_id) ?? 0),
  )) {
    if (!assetsByName.has(asset.name)) {
      assetsByName.set(asset.name, assetView(asset));
    }
  }

  const strings: Record<Locale, Record<string, string>> = { en: {}, es: {}, fr: {} };

  for (const entry of [...stringRows].sort(
    (left, right) => (depth.get(left.theme_id) ?? 0) - (depth.get(right.theme_id) ?? 0),
  )) {
    if (isLocale(entry.locale)) {
      strings[entry.locale][entry.key] ??= entry.value;
    }
  }

  return {
    tokens,
    css,
    assets: [...assetsByName.values()],
    strings,
  };
}

/** A translator that applies the theme's string overrides before the shipped catalog. */
export function themeTranslator(
  locale: Locale,
  overrides: Readonly<Record<string, string>>,
  fallback: Translator,
): Translator {
  return (key, values = {}) => {
    const override = overrides[key];

    return override === undefined ? fallback(key, values) : formatMessage(locale, override, values);
  };
}

async function nextTemplateVersion(sql: SQL, themeId: string, name: string): Promise<number> {
  const [row] = (await sql`
    SELECT coalesce(max(version), 0)::int + 1 AS version
    FROM core.theme_template_versions
    WHERE theme_id = ${themeId} AND name = ${name}
  `) as Array<{ version: number }>;

  return row?.version ?? 1;
}

async function bumpTheme(sql: SQL, themeId: string): Promise<void> {
  await sql`
    UPDATE core.themes SET version = version + 1, updated_at = now() WHERE id = ${themeId}
  `;
}

export interface CreateChildThemeInput {
  readonly name: string;
  readonly parentId: string;
  readonly actorId: string;
}

export async function createChildTheme(
  sql: SQL,
  input: CreateChildThemeInput,
): Promise<ThemeMutation<{ readonly id: string }>> {
  const parentId = idOf(input.parentId);

  if (parentId === null) {
    return { ok: false, code: "not_found" };
  }

  const name = validThemeName(input.name);

  if (name === null) {
    return { ok: false, code: "invalid_name" };
  }

  return sql.begin(async (tx) => {
    const [parent] = (await tx`
      SELECT id FROM core.themes WHERE id::text = ${parentId} FOR SHARE
    `) as Array<{ id: string }>;

    if (parent === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    const [existing] = (await tx`
      SELECT 1 FROM core.themes WHERE name = ${name}
    `) as unknown[];

    if (existing !== undefined) {
      return { ok: false as const, code: "duplicate_name" as const };
    }

    const [created] = (await tx`
      INSERT INTO core.themes (name, parent_id, version, source, created_by)
      VALUES (${name}, ${parent.id}, 1, 'custom', ${input.actorId})
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (created === undefined) {
      throw new Error("Could not create the child theme");
    }

    return { ok: true as const, result: { id: created.id } };
  });
}

export interface TemplateSaveInput {
  readonly themeId: string;
  readonly name: string;
  readonly body: string;
  readonly actorId: string;
}

export async function saveThemeTemplate(
  sql: SQL,
  input: TemplateSaveInput,
): Promise<ThemeMutation<{ readonly version: number }>> {
  const themeId = idOf(input.themeId);
  const name = validTemplateName(input.name);

  if (themeId === null) {
    return { ok: false, code: "not_found" };
  }

  if (name === null) {
    return { ok: false, code: "invalid_name" };
  }

  return sql.begin(async (tx) => {
    const [theme] = (await tx`
      SELECT id::text AS id, source FROM core.themes WHERE id::text = ${themeId} FOR UPDATE
    `) as Array<{ id: string; source: string }>;

    if (theme === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (theme.source === "core") {
      return { ok: false as const, code: "protected_theme" as const };
    }

    const version = await nextTemplateVersion(tx, theme.id, name);

    await tx`
      INSERT INTO core.theme_templates (theme_id, name, body, version, updated_by)
      VALUES (${theme.id}, ${name}, ${input.body}, ${version}, ${input.actorId})
      ON CONFLICT (theme_id, name) DO UPDATE
      SET body = EXCLUDED.body, version = EXCLUDED.version,
        updated_by = EXCLUDED.updated_by, updated_at = now()
    `;
    await tx`
      INSERT INTO core.theme_template_versions (theme_id, name, version, body, updated_by)
      VALUES (${theme.id}, ${name}, ${version}, ${input.body}, ${input.actorId})
    `;
    await bumpTheme(tx, theme.id);

    return { ok: true as const, result: { version } };
  });
}

export interface TemplateRestoreInput {
  readonly themeId: string;
  readonly name: string;
  readonly version: number;
  readonly actorId: string;
}

export async function restoreThemeTemplateVersion(
  sql: SQL,
  input: TemplateRestoreInput,
): Promise<ThemeMutation<{ readonly version: number }>> {
  const themeId = idOf(input.themeId);
  const name = validTemplateName(input.name);

  if (themeId === null) {
    return { ok: false, code: "not_found" };
  }

  if (name === null || !Number.isSafeInteger(input.version) || input.version < 1) {
    return { ok: false, code: "unknown_version" };
  }

  return sql.begin(async (tx) => {
    const [theme] = (await tx`
      SELECT id::text AS id, source FROM core.themes WHERE id::text = ${themeId} FOR UPDATE
    `) as Array<{ id: string; source: string }>;

    if (theme === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (theme.source === "core") {
      return { ok: false as const, code: "protected_theme" as const };
    }

    const [historical] = (await tx`
      SELECT body FROM core.theme_template_versions
      WHERE theme_id = ${theme.id} AND name = ${name} AND version = ${input.version}
    `) as Array<{ body: string }>;

    if (historical === undefined) {
      return { ok: false as const, code: "unknown_version" as const };
    }

    const version = await nextTemplateVersion(tx, theme.id, name);

    await tx`
      INSERT INTO core.theme_templates (theme_id, name, body, version, updated_by)
      VALUES (${theme.id}, ${name}, ${historical.body}, ${version}, ${input.actorId})
      ON CONFLICT (theme_id, name) DO UPDATE
      SET body = EXCLUDED.body, version = EXCLUDED.version,
        updated_by = EXCLUDED.updated_by, updated_at = now()
    `;
    await tx`
      INSERT INTO core.theme_template_versions (theme_id, name, version, body, updated_by)
      VALUES (${theme.id}, ${name}, ${version}, ${historical.body}, ${input.actorId})
    `;
    await bumpTheme(tx, theme.id);

    return { ok: true as const, result: { version } };
  });
}

export async function revertThemeTemplate(
  sql: SQL,
  input: { readonly themeId: string; readonly name: string; readonly actorId: string },
): Promise<ThemeMutation<{ readonly version: number }>> {
  const themeId = idOf(input.themeId);
  const name = validTemplateName(input.name);

  if (themeId === null) {
    return { ok: false, code: "not_found" };
  }

  if (name === null) {
    return { ok: false, code: "invalid_name" };
  }

  return sql.begin(async (tx) => {
    const [theme] = (await tx`
      SELECT id::text AS id, source, parent_id::text AS parent_id
      FROM core.themes WHERE id::text = ${themeId} FOR UPDATE
    `) as Array<{ id: string; source: string; parent_id: string | null }>;

    if (theme === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (theme.source === "core") {
      return { ok: false as const, code: "protected_theme" as const };
    }

    if (theme.parent_id === null) {
      return { ok: false as const, code: "invalid_theme" as const };
    }

    const [parent] = (await tx`
      SELECT 1 FROM core.theme_templates
      WHERE theme_id = ${theme.parent_id} AND name = ${name}
    `) as unknown[];

    if (parent === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    await tx`
      DELETE FROM core.theme_templates WHERE theme_id = ${theme.id} AND name = ${name}
    `;
    const [row] = (await tx`
      SELECT version FROM core.themes WHERE id = ${theme.id}
    `) as Array<{ version: number }>;
    await bumpTheme(tx, theme.id);

    return { ok: true as const, result: { version: (row?.version ?? 0) + 1 } };
  });
}

export async function saveThemeTokens(
  sql: SQL,
  input: { readonly themeId: string; readonly scheme: string; readonly tokens: unknown },
): Promise<ThemeMutation<Record<string, never>>> {
  const themeId = idOf(input.themeId);
  const tokens = validateTokenInput(input.tokens === undefined ? undefined : input);

  if (themeId === null) {
    return { ok: false, code: "not_found" };
  }

  if (!isTokenScheme(input.scheme)) {
    return { ok: false, code: "invalid_scheme" };
  }

  if (tokens === null) {
    return { ok: false, code: "invalid_theme" };
  }

  return sql.begin(async (tx) => {
    const [theme] = (await tx`
      SELECT id::text AS id, source FROM core.themes WHERE id::text = ${themeId} FOR UPDATE
    `) as Array<{ id: string; source: string }>;

    if (theme === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (theme.source === "core") {
      return { ok: false as const, code: "protected_theme" as const };
    }

    await tx`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens, updated_at)
      VALUES (${theme.id}, ${input.scheme}, ${JSON.stringify(tokens.tokens)}::jsonb, now())
      ON CONFLICT (theme_id, scheme) DO UPDATE
      SET tokens = EXCLUDED.tokens, updated_at = now()
    `;
    await bumpTheme(tx, theme.id);

    return { ok: true as const, result: {} };
  });
}

export async function saveThemeCss(
  sql: SQL,
  input: { readonly themeId: string; readonly css: string },
): Promise<ThemeMutation<Record<string, never>>> {
  const themeId = idOf(input.themeId);

  if (themeId === null) {
    return { ok: false, code: "not_found" };
  }

  if (input.css.length > 200_000) {
    return { ok: false, code: "invalid_theme" };
  }

  return sql.begin(async (tx) => {
    const [theme] = (await tx`
      SELECT id::text AS id, source FROM core.themes WHERE id::text = ${themeId} FOR UPDATE
    `) as Array<{ id: string; source: string }>;

    if (theme === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (theme.source === "core") {
      return { ok: false as const, code: "protected_theme" as const };
    }

    await tx`
      INSERT INTO core.theme_css (theme_id, css, updated_at)
      VALUES (${theme.id}, ${input.css}, now())
      ON CONFLICT (theme_id) DO UPDATE SET css = EXCLUDED.css, updated_at = now()
    `;
    await bumpTheme(tx, theme.id);

    return { ok: true as const, result: {} };
  });
}

export interface ThemeStringInput {
  readonly locale: string;
  readonly key: string;
  readonly value: string;
}

export async function saveThemeStrings(
  sql: SQL,
  input: { readonly themeId: string; readonly strings: readonly ThemeStringInput[] },
): Promise<ThemeMutation<Record<string, never>>> {
  const themeId = idOf(input.themeId);

  if (themeId === null) {
    return { ok: false, code: "not_found" };
  }

  if (input.strings.length > 2_000) {
    return { ok: false, code: "invalid_theme" };
  }

  for (const entry of input.strings) {
    if (!isLocale(entry.locale)) {
      return { ok: false, code: "invalid_locale" };
    }

    if (!STRING_KEY.test(entry.key) || entry.value.length > 5_000) {
      return { ok: false, code: "invalid_key" };
    }

    try {
      assertValidMessage(entry.locale, entry.value);
    } catch {
      return { ok: false, code: "invalid_key" };
    }
  }

  return sql.begin(async (tx) => {
    const [theme] = (await tx`
      SELECT id::text AS id, source FROM core.themes WHERE id::text = ${themeId} FOR UPDATE
    `) as Array<{ id: string; source: string }>;

    if (theme === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (theme.source === "core") {
      return { ok: false as const, code: "protected_theme" as const };
    }

    // The editor sends the complete override set, so a row the admin deleted must go too.
    for (const locale of ["en", "es", "fr"] as const) {
      const keys = input.strings
        .filter((entry) => entry.locale === locale)
        .map((entry) => entry.key);

      if (keys.length === 0) {
        await tx`
          DELETE FROM core.theme_strings WHERE theme_id = ${theme.id} AND locale = ${locale}
        `;
      } else {
        await tx`
          DELETE FROM core.theme_strings
          WHERE theme_id = ${theme.id} AND locale = ${locale}
            AND NOT (key = ANY(${`{${keys.join(",")}}`}::text[]))
        `;
      }
    }

    for (const entry of input.strings) {
      await tx`
        INSERT INTO core.theme_strings (theme_id, locale, key, value, updated_at)
        VALUES (${theme.id}, ${entry.locale}, ${entry.key}, ${entry.value}, now())
        ON CONFLICT (theme_id, locale, key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now()
      `;
    }

    await bumpTheme(tx, theme.id);

    return { ok: true as const, result: {} };
  });
}

export interface ThemeAssetInput {
  readonly themeId: string;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly storageKey: string;
  readonly actorId: string;
}

export async function saveThemeAsset(
  sql: SQL,
  input: ThemeAssetInput,
): Promise<ThemeMutation<{ readonly id: string; readonly replacedStorageKey?: string }>> {
  const themeId = idOf(input.themeId);

  if (themeId === null) {
    return { ok: false, code: "not_found" };
  }

  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(input.name)) {
    return { ok: false, code: "invalid_name" };
  }

  return sql.begin(async (tx) => {
    const [theme] = (await tx`
      SELECT id::text AS id, source FROM core.themes WHERE id::text = ${themeId} FOR UPDATE
    `) as Array<{ id: string; source: string }>;

    if (theme === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (theme.source === "core") {
      return { ok: false as const, code: "protected_theme" as const };
    }

    const [existing] = (await tx`
      SELECT id::text AS id, storage_key FROM core.theme_assets
      WHERE theme_id = ${theme.id} AND name = ${input.name}
    `) as Array<{ id: string; storage_key: string }>;

    const [row] = (await tx`
      INSERT INTO core.theme_assets (theme_id, name, storage_key, content_type, bytes, created_by)
      VALUES (${theme.id}, ${input.name}, ${input.storageKey}, ${input.contentType},
        ${input.bytes}, ${input.actorId})
      ON CONFLICT (theme_id, name) DO UPDATE
      SET storage_key = EXCLUDED.storage_key, content_type = EXCLUDED.content_type,
        bytes = EXCLUDED.bytes, created_by = EXCLUDED.created_by
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (row === undefined) {
      throw new Error("Could not save the theme asset");
    }

    await bumpTheme(tx, theme.id);

    return {
      ok: true as const,
      result: { id: row.id },
      ...(existing === undefined ? {} : { replacedStorageKey: existing.storage_key }),
    };
  });
}

export async function deleteThemeAsset(
  sql: SQL,
  input: { readonly themeId: string; readonly assetId: string },
): Promise<ThemeMutation<{ readonly storageKey: string }>> {
  const themeId = idOf(input.themeId);
  const assetId = idOf(input.assetId);

  if (themeId === null || assetId === null) {
    return { ok: false, code: "not_found" };
  }

  return sql.begin(async (tx) => {
    const [asset] = (await tx`
      DELETE FROM core.theme_assets
      WHERE id::text = ${assetId} AND theme_id::text = ${themeId}
      RETURNING storage_key
    `) as Array<{ storage_key: string }>;

    if (asset === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    await bumpTheme(tx, themeId);

    return { ok: true as const, result: { storageKey: asset.storage_key } };
  });
}

/**
 * The `bp` cookie's theme must exist and be available to Guests. An empty allowed list means
 * everyone; a restricted theme is refused here so a guest cannot name a VIP theme (ADR 0006).
 */
export async function themeAllowedForGuests(sql: SQL, themeId: string): Promise<boolean> {
  const id = idOf(themeId);

  if (id === null) {
    return false;
  }

  const rows = (await sql`
    SELECT 1
    FROM core.themes t
    WHERE t.id::text = ${id}
      AND (
        NOT EXISTS (SELECT 1 FROM core.theme_allowed_groups g WHERE g.theme_id = t.id)
        OR EXISTS (
          SELECT 1
          FROM core.theme_allowed_groups g
          JOIN core.groups grp ON grp.id = g.group_id
          WHERE g.theme_id = t.id AND grp.key = 'guests'
        )
      )
  `) as unknown[];

  return rows.length > 0;
}

/** The theme named by the guest's `bp` cookie when it is active and allowed, else null. */
export async function guestThemeId(
  sql: SQL,
  themeId: string | null | undefined,
): Promise<string | null> {
  if (themeId === null || themeId === undefined) {
    return null;
  }

  return (await themeAllowedForGuests(sql, themeId)) ? themeId : null;
}

/** The preview theme granted to a member's session, if it is still active. */
export async function previewThemeForSession(
  sql: SQL,
  sessionId: string | null | undefined,
): Promise<string | null> {
  if (sessionId === null || sessionId === undefined || !/^\d+$/.test(sessionId)) {
    return null;
  }

  const [row] = (await sql`
    SELECT g.resource_id::text AS id
    FROM core.session_grants g
    JOIN core.themes t ON t.id = g.resource_id
    WHERE g.session_id = ${sessionId}
      AND g.kind = 'preview_theme_id'
      AND (g.expires_at IS NULL OR g.expires_at > now())
    LIMIT 1
  `) as Array<{ id: string }>;

  return row?.id ?? null;
}

/**
 * Stores the preview grant for the current session. The definer function re-checks the
 * session and theme, so user-app never receives a general INSERT grant on session state
 * (ADR 0001, ADR 0018).
 */
export async function grantPreviewTheme(
  sql: SQL,
  sessionId: string,
  themeId: string,
): Promise<boolean> {
  const [row] = (await sql`
    SELECT core.grant_preview_theme(${sessionId}, ${themeId}) AS granted
  `) as Array<{ granted: boolean }>;

  return row?.granted === true;
}
