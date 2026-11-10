import { bumpCacheTags } from "@bulletin/cache";
import {
  CATALOGS,
  type Catalog,
  type Locale,
  type RuntimeCatalogIssue,
  type StringOverrideSource,
  stringOverrideTag,
  validateRuntimeMessage,
} from "@bulletin/i18n";
import type { SQL } from "bun";

export const STRING_OVERRIDE_NOTIFY_CHANNEL = "bulletin_cache_tags";

export interface StringOverrideWrite {
  readonly locale: Locale;
  readonly key: string;
  readonly value: string;
  readonly updatedBy?: bigint | null;
}

export interface StringOverrideSaveOptions {
  /** The catalog the key belongs to, normally the merged English catalog. */
  readonly base?: Catalog;
}

export class StringOverrideError extends Error {
  readonly issues: readonly RuntimeCatalogIssue[];

  constructor(issues: readonly RuntimeCatalogIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "StringOverrideError";
    this.issues = issues;
  }
}

async function bumpTag(sql: SQL, locale: Locale): Promise<void> {
  await bumpCacheTags(sql, [stringOverrideTag(locale)]);
}

export async function readStringOverrideVersion(sql: SQL, locale: Locale): Promise<string> {
  const rows = (await sql`
    SELECT version::text AS version
    FROM core.cache_tags
    WHERE tag = ${stringOverrideTag(locale)}
  `) as Array<{ version: string }>;

  return rows[0]?.version ?? "0";
}

export async function loadStringOverrides(sql: SQL, locale: Locale): Promise<Catalog> {
  const rows = (await sql`
    SELECT key, value
    FROM core.string_overrides
    WHERE locale = ${locale}
    ORDER BY key
  `) as Array<{ key: string; value: string }>;

  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function createStringOverrideSource(sql: SQL): StringOverrideSource {
  return {
    version: (locale) => readStringOverrideVersion(sql, locale),
    load: (locale) => loadStringOverrides(sql, locale),
  };
}

export async function setStringOverride(
  sql: SQL,
  override: StringOverrideWrite,
  options: StringOverrideSaveOptions = {},
): Promise<void> {
  await sql.begin(async (tx) => {
    await writeStringOverride(tx, override, options);
  });
}

/**
 * Validates and writes one override in the caller's transaction. Every write route uses this
 * so the audit row can commit atomically with the string change.
 */
export async function writeStringOverride(
  sql: SQL,
  override: StringOverrideWrite,
  options: StringOverrideSaveOptions = {},
): Promise<void> {
  const base: Catalog = options.base ?? CATALOGS.en;
  const baseMessage = base[override.key];

  if (baseMessage === undefined) {
    throw new StringOverrideError([
      {
        code: "unknown_key",
        key: override.key,
        message: `"${override.key}" is not defined in the base catalog`,
      },
    ]);
  }

  const issues = validateRuntimeMessage({
    locale: override.locale,
    key: override.key,
    message: override.value,
    baseMessage,
  });

  if (issues.length > 0) {
    throw new StringOverrideError(issues);
  }

  await sql`
    INSERT INTO core.string_overrides (locale, key, value, updated_by, updated_at)
    VALUES (${override.locale}, ${override.key}, ${override.value}, ${override.updatedBy ?? null}, now())
    ON CONFLICT (locale, key) DO UPDATE
    SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
  await bumpTag(sql, override.locale);
}

export async function deleteStringOverride(
  sql: SQL,
  override: Pick<StringOverrideWrite, "locale" | "key">,
): Promise<void> {
  await sql.begin(async (tx) => {
    await writeStringOverrideDelete(tx, override);
  });
}

/** Deletes one override and bumps its locale tag in the caller's transaction. */
export async function writeStringOverrideDelete(
  sql: SQL,
  override: Pick<StringOverrideWrite, "locale" | "key">,
): Promise<void> {
  await sql`
    DELETE FROM core.string_overrides
    WHERE locale = ${override.locale} AND key = ${override.key}
  `;
  await bumpTag(sql, override.locale);
}
