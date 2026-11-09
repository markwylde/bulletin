import {
  StringOverrideError,
  writeStringOverride,
  writeStringOverrideDelete,
} from "@bulletin/db/i18n";
import { isLocale, LOCALES, type Locale, type RuntimeCatalogIssue } from "@bulletin/i18n";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";
import { EDITOR_BASE, EDITOR_CATALOGS } from "./i18n-catalog.ts";

export interface OverrideKeyView {
  readonly key: string;
  readonly base: string;
  readonly values: Readonly<Record<Locale, string>>;
  readonly overrides: Partial<Record<Locale, string>>;
}

export interface ActiveOverride {
  readonly locale: Locale;
  readonly key: string;
  readonly value: string;
  readonly shipped: string;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
}

export interface SaveOverrideSetInput {
  readonly key: string;
  readonly values: Partial<Record<Locale, string>>;
}

export type SaveOverrideResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "unknown_key" | "invalid_override";
      readonly issues?: readonly RuntimeCatalogIssue[];
    };

export type RevertOverrideResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "unknown_key" | "not_found" };

type OverrideMap = Partial<Record<Locale, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshot(overrides: OverrideMap): Record<Locale, string | null> {
  return {
    en: overrides.en ?? null,
    es: overrides.es ?? null,
    fr: overrides.fr ?? null,
  };
}

async function allOverrides(
  sql: SQL,
): Promise<Array<{ locale: Locale; key: string; value: string }>> {
  const rows = (await sql`
    SELECT locale, key, value
    FROM core.string_overrides
    ORDER BY key, locale
  `) as Array<{ locale: string; key: string; value: string }>;

  return rows.flatMap((row) =>
    isLocale(row.locale) ? [{ locale: row.locale, key: row.key, value: row.value }] : [],
  );
}

function groupByKey(
  rows: readonly { readonly locale: Locale; readonly key: string; readonly value: string }[],
): Map<string, OverrideMap> {
  const map = new Map<string, OverrideMap>();

  for (const row of rows) {
    const overrides = map.get(row.key) ?? {};
    overrides[row.locale] = row.value;
    map.set(row.key, overrides);
  }

  return map;
}

export async function searchOverrideKeys(sql: SQL, query: string): Promise<OverrideKeyView[]> {
  const needle = query.trim().toLowerCase();
  const keys = Object.keys(EDITOR_BASE)
    .filter((key) => {
      if (needle === "") {
        return true;
      }

      return key.toLowerCase().includes(needle) || EDITOR_BASE[key]?.toLowerCase().includes(needle);
    })
    .sort()
    .slice(0, 50);
  const byKey = groupByKey(await allOverrides(sql));

  return keys.map((key) => {
    const overrides = byKey.get(key) ?? {};

    return {
      key,
      base: EDITOR_BASE[key] ?? "",
      values: {
        en: EDITOR_CATALOGS.en[key] ?? "",
        es: EDITOR_CATALOGS.es[key] ?? "",
        fr: EDITOR_CATALOGS.fr[key] ?? "",
      },
      overrides,
    };
  });
}

export async function listActiveOverrides(sql: SQL): Promise<ActiveOverride[]> {
  const rows = (await sql`
    SELECT o.locale, o.key, o.value, o.updated_at, m.display_name AS updated_by
    FROM core.string_overrides o
    LEFT JOIN core.members m ON m.id = o.updated_by
    ORDER BY o.key, o.locale
  `) as Array<{
    locale: string;
    key: string;
    value: string;
    updated_at: Date;
    updated_by: string | null;
  }>;

  return rows.flatMap((row) =>
    isLocale(row.locale)
      ? [
          {
            locale: row.locale,
            key: row.key,
            value: row.value,
            shipped: EDITOR_CATALOGS[row.locale][row.key] ?? "",
            updatedBy: row.updated_by,
            updatedAt: row.updated_at.toISOString(),
          },
        ]
      : [],
  );
}

function parseValues(value: unknown): Partial<Record<Locale, string>> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Partial<Record<Locale, string>> = {};

  for (const locale of LOCALES) {
    const entry = value[locale];

    if (typeof entry === "string") {
      result[locale] = entry;
    }
  }

  return result;
}

function overrideLockKey(key: string): string {
  return `bulletin.string_override:${key}`;
}

export async function saveOverrideSet(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<SaveOverrideResult> {
  if (!isRecord(input) || typeof input.key !== "string" || !Object.hasOwn(EDITOR_BASE, input.key)) {
    return { ok: false, code: "unknown_key" };
  }

  const key = input.key;
  const values = parseValues(input.values);

  if (Object.keys(values).length === 0) {
    return { ok: false, code: "unknown_key" };
  }

  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${overrideLockKey(key)})::bigint)`;

      const beforeMap = groupByKey(await allOverrides(tx)).get(key) ?? {};
      const before = snapshot(beforeMap);
      const after = { ...before };

      for (const locale of LOCALES) {
        const value = values[locale];

        if (value !== undefined) {
          after[locale] = value.trim() === "" ? null : value;
        }
      }

      for (const locale of LOCALES) {
        const value = values[locale];

        if (value === undefined) {
          continue;
        }

        if (value.trim() === "") {
          await writeStringOverrideDelete(tx, { locale, key });
        } else {
          await writeStringOverride(
            tx,
            { locale, key, value, updatedBy: BigInt(actorMemberId) },
            { base: EDITOR_BASE },
          );
        }
      }

      await writeAdminLog(tx, {
        actorMemberId,
        action: "i18n.override.update",
        targetType: "i18n_key",
        targetId: null,
        summary: { key, before, after },
      });
    });
  } catch (error) {
    if (error instanceof StringOverrideError) {
      return { ok: false, code: "invalid_override", issues: error.issues };
    }

    throw error;
  }

  return { ok: true };
}

export async function revertOverride(
  sql: SQL,
  actorMemberId: string,
  locale: string | null,
  key: string | null,
): Promise<RevertOverrideResult> {
  if (key === null || !Object.hasOwn(EDITOR_BASE, key)) {
    return { ok: false, code: "unknown_key" };
  }

  if (!isLocale(locale)) {
    return { ok: false, code: "not_found" };
  }

  const result = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${overrideLockKey(key)})::bigint)`;

    const beforeMap = groupByKey(await allOverrides(tx)).get(key) ?? {};

    if (beforeMap[locale] === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    const before = snapshot(beforeMap);
    const after = { ...before, [locale]: null };

    await writeStringOverrideDelete(tx, { locale, key });
    await writeAdminLog(tx, {
      actorMemberId,
      action: "i18n.override.revert",
      targetType: "i18n_key",
      targetId: null,
      summary: { key, before, after },
    });

    return { ok: true } as const;
  });

  return result;
}
