import {
  assertValidMessage,
  formatMessage,
  isLocale,
  type Locale,
  type Translator,
} from "@bulletin/i18n";
import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import { GUEST_PRINCIPAL } from "../permissions/principal.ts";

export type ThemeSource = "core" | "marketplace" | "upload" | "custom";

export interface ThemeSummary {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly parentName: string | null;
  readonly version: number;
  readonly source: ThemeSource;
  readonly isActive: boolean;
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
  readonly isActive: boolean;
  readonly description: string;
  readonly editable: boolean;
  readonly templates: readonly ThemeTemplateView[];
  readonly versions: readonly ThemeTemplateVersion[];
  readonly tokens: readonly ThemeTokenRecord[];
  readonly css: string;
  readonly assets: readonly ThemeAssetRecord[];
  readonly strings: readonly ThemeStringRecord[];
  /** Groups this theme is restricted to; an empty list means everyone. */
  readonly allowedGroupIds: readonly string[];
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

    if (!isSafeTokenValue(trimmed)) {
      return null;
    }

    tokens[key] = trimmed;
  }

  return { scheme: value.scheme, tokens };
}

/** Decodes CSS escapes such as `u\72l` so a token cannot hide a resource function. */
function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_match, escaped: string) => {
    if (/^[0-9a-f]{1,6}\s?$/i.test(escaped)) {
      const codePoint = Number.parseInt(escaped.trim(), 16);
      return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    }

    return escaped;
  });
}

/** A token value safe to write into a CSS custom property declaration. */
export function isSafeTokenValue(value: string): boolean {
  const decoded = decodeCssEscapes(value);

  return (
    value.length <= 120 &&
    !/[;{}<>]/.test(value) &&
    !/(?:url|image|image-set|cross-fade|element|paint)\s*\(/i.test(decoded) &&
    !/(?:https?:|data:|javascript:|vbscript:)/i.test(decoded)
  );
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
  readonly is_active: boolean;
  readonly description: string;
  readonly updated_at: Date;
  readonly template_count: number;
  readonly child_count: number;
}

export async function listThemes(sql: SQL): Promise<readonly ThemeSummary[]> {
  const rows = (await sql`
    SELECT t.id::text AS id, t.name, t.parent_id::text AS parent_id, p.name AS parent_name,
      t.version, t.source, t.is_active, t.description, t.updated_at,
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
    isActive: row.is_active,
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
  readonly is_active: boolean;
  readonly description: string;
}

async function themeRow(sql: SQL, themeId: string): Promise<DetailRow | null> {
  const [row] = (await sql`
    SELECT t.id::text AS id, t.name, t.parent_id::text AS parent_id, p.name AS parent_name,
      t.version, t.source, t.is_active, t.description
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
  const allowedGroups = (await sql`
    SELECT group_id::text AS group_id FROM core.theme_allowed_groups WHERE theme_id = ${row.id}
    ORDER BY group_id
  `) as Array<{ group_id: string }>;
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
      if (!parentByName.has(template.name)) {
        parentByName.set(template.name, { body: template.body, version: template.version });
      }
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
    isActive: row.is_active,
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
    allowedGroupIds: allowedGroups.map((entry) => entry.group_id),
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
      INSERT INTO core.themes (name, parent_id, version, source, is_active, created_by)
      VALUES (${name}, ${parent.id}, 1, 'custom', false, ${input.actorId})
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
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, ARRAY[id] AS path
        FROM core.themes
        WHERE id = ${theme.parent_id}
        UNION ALL
        SELECT child.id, child.parent_id, ancestor.path || child.id
        FROM core.themes AS child
        JOIN ancestors AS ancestor ON child.id = ancestor.parent_id
        WHERE NOT child.id = ANY(ancestor.path)
      )
      SELECT 1
      FROM core.theme_templates template
      JOIN ancestors ON ancestors.id = template.theme_id
      WHERE template.name = ${name}
      LIMIT 1
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
      VALUES (${theme.id}, ${input.scheme}, ${tokens.tokens}::jsonb, now())
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

  return can(sql, GUEST_PRINCIPAL, "use_theme", { themeId: id });
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
  memberId: string,
): Promise<string | null> {
  if (
    sessionId === null ||
    sessionId === undefined ||
    !/^\d+$/.test(sessionId) ||
    !(await can(sql, memberId, "acp.themes"))
  ) {
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

export interface ThemeOption {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface AppearanceOptions {
  readonly member: boolean;
  readonly themes: readonly ThemeOption[];
  readonly themeId: string | null;
  readonly scheme: import("@bulletin/i18n").ColorScheme;
}

interface ViewerGroup {
  readonly id: string;
  readonly key: string;
  readonly isPrimary: boolean;
}

async function viewerGroups(sql: SQL, memberId: string | null): Promise<readonly ViewerGroup[]> {
  if (memberId === null) {
    const rows = (await sql`
      SELECT id::text AS id, key FROM core.groups WHERE key = 'guests'
    `) as Array<{ id: string; key: string }>;

    return rows.map((row) => ({ ...row, isPrimary: true }));
  }

  return (await sql`
    SELECT g.id::text AS id, g.key, mg.is_primary
    FROM core.member_groups mg
    JOIN core.groups g ON g.id = mg.group_id
    WHERE mg.member_id = ${memberId}
    ORDER BY mg.is_primary DESC, g.id
  `) as ViewerGroup[];
}

/** Themes available to any of these groups; an empty allowed list means everyone. */
export async function allowedThemesForGroups(
  sql: SQL,
  groupIds: readonly string[],
): Promise<readonly ThemeOption[]> {
  if (groupIds.length === 0) {
    return [];
  }

  const themes = (await sql`
    SELECT t.id::text AS id, t.name, t.description
    FROM core.themes t
    WHERE t.is_active
    ORDER BY t.name
  `) as ThemeOption[];
  const allowed: ThemeOption[] = [];

  for (const theme of themes) {
    if (
      await can(sql, GUEST_PRINCIPAL, "use_theme", {
        themeId: theme.id,
        groupIds,
      })
    ) {
      allowed.push(theme);
    }
  }

  return allowed;
}

export async function coreDefaultThemeId(sql: SQL): Promise<string | null> {
  const [row] = (await sql`
    SELECT id::text AS id FROM core.themes WHERE name = 'default' AND is_active
  `) as Array<{ id: string }>;

  return row?.id ?? null;
}

async function groupDefaultThemeId(sql: SQL, groupId: string | null): Promise<string | null> {
  if (groupId === null) {
    return null;
  }

  const [row] = (await sql`
    SELECT theme_id::text AS id FROM core.theme_group_defaults WHERE group_id = ${groupId}
  `) as Array<{ id: string }>;

  return row?.id ?? null;
}

async function memberPreference(
  sql: SQL,
  memberId: string,
): Promise<{ themeId: string | null; scheme: import("@bulletin/i18n").ColorScheme }> {
  const [row] = (await sql`
    SELECT theme_id::text AS theme_id, colour_scheme
    FROM core.member_prefs
    WHERE member_id = ${memberId}
  `) as Array<{ theme_id: string | null; colour_scheme: string }>;
  const scheme =
    row?.colour_scheme === "light" || row?.colour_scheme === "dark" ? row.colour_scheme : "system";

  return { themeId: row?.theme_id ?? null, scheme };
}

/**
 * The chooser list and the theme actually rendered for this viewer (ADR 0008). A saved choice
 * that is no longer allowed for any of the member's groups falls back to the primary group's
 * default, which is the "lost access" rule.
 */
export async function appearanceOptions(
  sql: SQL,
  memberId: string | null,
): Promise<AppearanceOptions> {
  const groups = await viewerGroups(sql, memberId);
  const groupIds = groups.map((group) => group.id);
  const themes = [...(await allowedThemesForGroups(sql, groupIds))];
  const primary = groups.find((group) => group.isPrimary)?.id ?? groupIds[0] ?? null;
  const groupDefault = await groupDefaultThemeId(sql, primary);
  const coreDefault = await coreDefaultThemeId(sql);

  if (coreDefault !== null && !themes.some((theme) => theme.id === coreDefault)) {
    const [defaultTheme] = (await sql`
      SELECT id::text AS id, name, description FROM core.themes WHERE id = ${coreDefault}
    `) as ThemeOption[];

    if (defaultTheme !== undefined) {
      themes.unshift(defaultTheme);
    }
  }

  const allowed = new Set(themes.map((theme) => theme.id));
  const preference = memberId === null ? null : await memberPreference(sql, memberId);
  const chosen = preference?.themeId ?? null;
  const themeId =
    chosen !== null && allowed.has(chosen)
      ? chosen
      : groupDefault !== null && allowed.has(groupDefault)
        ? groupDefault
        : coreDefault;

  return {
    member: memberId !== null,
    themes,
    themeId,
    scheme: preference?.scheme ?? "system",
  };
}

/** The theme and scheme the viewer should render, including the lost-access fallback. */
export async function memberAppearance(
  sql: SQL,
  memberId: string,
): Promise<{ themeId: string | null; scheme: import("@bulletin/i18n").ColorScheme }> {
  const options = await appearanceOptions(sql, memberId);
  return { themeId: options.themeId, scheme: options.scheme };
}

export async function saveMemberAppearance(
  sql: SQL,
  memberId: string,
  input: { readonly themeId: string | null; readonly scheme: string },
): Promise<ThemeMutation<Record<string, never>>> {
  const scheme =
    input.scheme === "light" || input.scheme === "dark" || input.scheme === "system"
      ? input.scheme
      : null;

  if (scheme === null) {
    return { ok: false, code: "invalid_scheme" };
  }

  const groups = await viewerGroups(sql, memberId);

  if (
    input.themeId !== null &&
    !(await can(sql, memberId, "use_theme", {
      themeId: input.themeId,
      groupIds: groups.map((group) => group.id),
    }))
  ) {
    return { ok: false, code: "not_found" };
  }

  await sql`
    INSERT INTO core.member_prefs (member_id, theme_id, colour_scheme, updated_at)
    VALUES (${memberId}, ${input.themeId}, ${scheme}, now())
    ON CONFLICT (member_id) DO UPDATE
      SET theme_id = EXCLUDED.theme_id,
          colour_scheme = EXCLUDED.colour_scheme,
          updated_at = now()
  `;

  return { ok: true, result: {} };
}

export interface ThemeAvailability {
  readonly themes: readonly { readonly id: string; readonly name: string }[];
  readonly groups: readonly {
    readonly id: string;
    readonly key: string;
    readonly title: string;
    readonly defaultThemeId: string | null;
  }[];
  readonly allowed: readonly { readonly themeId: string; readonly groupId: string }[];
}

export async function listThemeAvailability(sql: SQL): Promise<ThemeAvailability> {
  const [themes, groups, allowed] = await Promise.all([
    sql`
      SELECT id::text AS id, name FROM core.themes ORDER BY name
    ` as Promise<Array<{ id: string; name: string }>>,
    sql`
      SELECT g.id::text AS id, g.key, g.title, d.theme_id::text AS default_theme_id
      FROM core.groups g
      LEFT JOIN core.theme_group_defaults d ON d.group_id = g.id
      ORDER BY g.display_order, g.id
    ` as Promise<
      Array<{ id: string; key: string; title: string; default_theme_id: string | null }>
    >,
    sql`
      SELECT theme_id::text AS theme_id, group_id::text AS group_id
      FROM core.theme_allowed_groups
      ORDER BY theme_id, group_id
    ` as Promise<Array<{ theme_id: string; group_id: string }>>,
  ]);

  return {
    themes,
    groups: groups.map((group) => ({
      id: group.id,
      key: group.key,
      title: group.title,
      defaultThemeId: group.default_theme_id,
    })),
    allowed: allowed.map((entry) => ({ themeId: entry.theme_id, groupId: entry.group_id })),
  };
}

export async function saveThemeAllowedGroups(
  sql: SQL,
  input: { readonly themeId: string; readonly groupIds: readonly string[] },
): Promise<ThemeMutation<Record<string, never>>> {
  const themeId = idOf(input.themeId);

  if (themeId === null) {
    return { ok: false, code: "not_found" };
  }

  return sql.begin(async (tx) => {
    const [theme] = (await tx`
      SELECT id::text AS id FROM core.themes WHERE id::text = ${themeId} FOR UPDATE
    `) as Array<{ id: string }>;

    if (theme === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    const groupIds = [...new Set(input.groupIds.filter((id) => /^\d+$/.test(id)))];

    if (groupIds.length > 0) {
      const rows = (await tx`
        SELECT count(*)::int AS count FROM core.groups
        WHERE id::text = ANY(${`{${groupIds.join(",")}}`}::text[])
      `) as Array<{ count: number }>;

      if ((rows[0]?.count ?? 0) !== groupIds.length) {
        return { ok: false as const, code: "invalid_name" as const };
      }
    }

    await tx`DELETE FROM core.theme_allowed_groups WHERE theme_id = ${theme.id}`;

    for (const groupId of groupIds) {
      await tx`
        INSERT INTO core.theme_allowed_groups (theme_id, group_id)
        VALUES (${theme.id}, ${groupId})
      `;
    }

    return { ok: true as const, result: {} };
  });
}

export async function saveGroupDefaultTheme(
  sql: SQL,
  input: { readonly groupId: string; readonly themeId: string | null },
): Promise<ThemeMutation<Record<string, never>>> {
  const groupId = idOf(input.groupId);

  if (groupId === null) {
    return { ok: false, code: "not_found" };
  }

  if (input.themeId === null) {
    await sql`DELETE FROM core.theme_group_defaults WHERE group_id = ${groupId}`;
    return { ok: true, result: {} };
  }

  const themeId = idOf(input.themeId);

  if (themeId === null) {
    return { ok: false, code: "not_found" };
  }

  const [allowed] = (await sql`
    SELECT
      EXISTS (SELECT 1 FROM core.themes WHERE id::text = ${themeId} AND is_active) AS theme_exists,
      (
        NOT EXISTS (SELECT 1 FROM core.theme_allowed_groups WHERE theme_id::text = ${themeId})
        OR EXISTS (
          SELECT 1 FROM core.theme_allowed_groups
          WHERE theme_id::text = ${themeId} AND group_id::text = ${groupId}
        )
      ) AS allowed
  `) as Array<{ theme_exists: boolean; allowed: boolean }>;

  if (allowed?.theme_exists !== true) {
    return { ok: false, code: "not_found" };
  }

  if (!allowed.allowed) {
    return { ok: false, code: "invalid_theme" };
  }

  await sql`
    INSERT INTO core.theme_group_defaults (group_id, theme_id)
    VALUES (${groupId}, ${themeId})
    ON CONFLICT (group_id) DO UPDATE SET theme_id = EXCLUDED.theme_id
  `;

  return { ok: true, result: {} };
}

/** The guest group's configured default theme, used when the `bp` cookie names none. */
export async function guestDefaultThemeId(sql: SQL): Promise<string | null> {
  const [row] = (await sql`
    SELECT d.theme_id::text AS id
    FROM core.theme_group_defaults d
    JOIN core.groups g ON g.id = d.group_id
    WHERE g.key = 'guests'
  `) as Array<{ id: string }>;

  return row?.id ?? null;
}

/** Activates/deactivates a theme. The bundled default can never be switched off. */
export async function setThemeActive(
  sql: SQL,
  input: { readonly themeId: string; readonly active: boolean },
): Promise<ThemeMutation<{ readonly isActive: boolean }>> {
  const themeId = idOf(input.themeId);

  if (themeId === null) {
    return { ok: false, code: "not_found" };
  }

  return sql.begin(async (tx) => {
    const [theme] = (await tx`
      SELECT id::text AS id, source FROM core.themes WHERE id::text = ${themeId} FOR UPDATE
    `) as Array<{ id: string; source: string }>;

    if (theme === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (theme.source === "core" && !input.active) {
      return { ok: false as const, code: "protected_theme" as const };
    }

    await tx`
      UPDATE core.themes SET is_active = ${input.active}, updated_at = now()
      WHERE id = ${theme.id}
    `;

    return { ok: true as const, result: { isActive: input.active } };
  });
}
