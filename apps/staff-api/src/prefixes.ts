import { prefixMutation, runMutation } from "@bulletin/domain/mutations";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

export const PREFIX_LOCALES = ["en", "es", "fr"] as const;
export type PrefixLocale = (typeof PREFIX_LOCALES)[number];

export interface PrefixAdminRecord {
  readonly id: string;
  readonly key: string;
  readonly colour: string;
  readonly labels: Readonly<Partial<Record<PrefixLocale, string>>>;
  readonly groupIds: readonly string[];
}

export type PrefixMutationCode =
  | "invalid_request"
  | "invalid_key"
  | "invalid_colour"
  | "invalid_labels"
  | "invalid_group"
  | "duplicate_key"
  | "not_found";

export type PrefixMutation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PrefixMutationCode };

interface PrefixRow {
  readonly id: string;
  readonly key: string;
  readonly colour: string;
}

const KEY = /^[a-z][a-z0-9_]*$/;
const COLOUR = /^#[0-9a-fA-F]{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function prefixForumIds(sql: SQL, prefixId: string): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT forum_id::text AS forum_id FROM core.forum_prefixes WHERE prefix_id = ${prefixId}
  `) as Array<{ forum_id: string }>;

  return rows.map((row) => row.forum_id);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

function parseLabels(value: unknown): Record<PrefixLocale, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const labels = {} as Record<PrefixLocale, string>;

  for (const locale of PREFIX_LOCALES) {
    const label = value[locale];

    if (label === undefined) {
      continue;
    }

    if (typeof label !== "string" || label.length > 80) {
      return null;
    }

    const trimmed = label.trim();

    if (trimmed !== "") {
      labels[locale] = trimmed;
    }
  }

  return (labels.en ?? "") === "" ? null : labels;
}

export async function listPrefixesAdmin(sql: SQL): Promise<{
  readonly prefixes: readonly PrefixAdminRecord[];
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
}> {
  const rows = (await sql`
    SELECT id, key, colour FROM core.prefixes ORDER BY display_order, id
  `) as PrefixRow[];
  const labels = (await sql`
    SELECT prefix_id, locale, label FROM core.prefix_labels
  `) as Array<{ prefix_id: string; locale: string; label: string }>;
  const groups = (await sql`
    SELECT prefix_id, group_id FROM core.prefix_groups
  `) as Array<{ prefix_id: string; group_id: string }>;
  const groupRows = (await sql`
    SELECT id, key, title FROM core.groups ORDER BY display_order, id
  `) as Array<{ id: string; key: string; title: string }>;

  return {
    prefixes: rows.map((row) => {
      const byLocale: Partial<Record<PrefixLocale, string>> = {};

      for (const label of labels) {
        if (
          label.prefix_id === row.id &&
          (PREFIX_LOCALES as readonly string[]).includes(label.locale)
        ) {
          byLocale[label.locale as PrefixLocale] = label.label;
        }
      }

      return {
        id: row.id,
        key: row.key,
        colour: row.colour,
        labels: byLocale,
        groupIds: groups
          .filter((group) => group.prefix_id === row.id)
          .map((group) => group.group_id),
      };
    }),
    groups: groupRows,
  };
}

export async function savePrefix(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<PrefixMutation> {
  if (!isRecord(input)) {
    return { ok: false, code: "invalid_request" };
  }

  const id = typeof input.id === "string" ? input.id : null;
  const key = typeof input.key === "string" ? input.key.trim() : "";
  const colour = typeof input.colour === "string" ? input.colour.trim() : "";
  const labels = parseLabels(input.labels);
  const groupIds = Array.isArray(input.groupIds)
    ? [...new Set(input.groupIds.filter((value): value is string => typeof value === "string"))]
    : null;

  if (!KEY.test(key)) {
    return { ok: false, code: "invalid_key" };
  }

  if (!COLOUR.test(colour)) {
    return { ok: false, code: "invalid_colour" };
  }

  if (labels === null) {
    return { ok: false, code: "invalid_labels" };
  }

  if (groupIds === null) {
    return { ok: false, code: "invalid_group" };
  }

  if (groupIds.length > 0) {
    const found = (await sql`
      SELECT id FROM core.groups WHERE id = ANY(${`{${groupIds.join(",")}}`}::bigint[])
    `) as Array<{ id: string }>;

    if (found.length !== groupIds.length) {
      return { ok: false, code: "invalid_group" };
    }
  }

  const affectedForumIds = id === null ? [] : await prefixForumIds(sql, id);

  try {
    return await runMutation({
      sql,
      mutation: prefixMutation,
      input: { affectedForumIds },
      apply: async (tx) => {
        let prefixId = id;

        if (prefixId === null) {
          const [row] = (await tx`
          INSERT INTO core.prefixes (key, colour) VALUES (${key}, ${colour}) RETURNING id
        `) as Array<{ id: string }>;

          if (row === undefined) {
            throw new Error("Prefix insert returned no row");
          }

          prefixId = row.id;
        } else {
          const [row] = (await tx`
          SELECT id FROM core.prefixes WHERE id = ${prefixId} FOR UPDATE
        `) as Array<{ id: string }>;

          if (row === undefined) {
            return { ok: false, code: "not_found" } as const;
          }

          await tx`UPDATE core.prefixes SET key = ${key}, colour = ${colour} WHERE id = ${prefixId}`;
        }

        await tx`DELETE FROM core.prefix_labels WHERE prefix_id = ${prefixId}`;

        for (const locale of PREFIX_LOCALES) {
          const label = labels[locale];

          if (label !== undefined) {
            await tx`
            INSERT INTO core.prefix_labels (prefix_id, locale, label)
            VALUES (${prefixId}, ${locale}, ${label})
          `;
          }
        }

        await tx`DELETE FROM core.prefix_groups WHERE prefix_id = ${prefixId}`;

        for (const groupId of groupIds) {
          await tx`
          INSERT INTO core.prefix_groups (prefix_id, group_id) VALUES (${prefixId}, ${groupId})
        `;
        }

        await writeAdminLog(tx, {
          actorMemberId,
          action: id === null ? "prefix.create" : "prefix.update",
          targetType: "prefix",
          targetId: prefixId,
          summary: { key, colour, labels, groupIds },
        });
        return { ok: true } as const;
      },
    });
  } catch (error) {
    return { ok: false, code: isUniqueViolation(error) ? "duplicate_key" : "invalid_request" };
  }
}

export async function deletePrefix(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<PrefixMutation> {
  if (!isRecord(input) || typeof input.id !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const affectedForumIds = await prefixForumIds(sql, input.id);

  return runMutation({
    sql,
    mutation: prefixMutation,
    input: { affectedForumIds },
    apply: async (tx) => {
      const [prefix] = (await tx`
        SELECT id, key FROM core.prefixes WHERE id = ${input.id} FOR UPDATE
      `) as Array<{ id: string; key: string }>;

      if (prefix === undefined) {
        return { ok: false, code: "not_found" } as const;
      }

      await tx`DELETE FROM core.prefixes WHERE id = ${input.id}`;
      await writeAdminLog(tx, {
        actorMemberId,
        action: "prefix.delete",
        targetType: "prefix",
        targetId: prefix.id,
        summary: { key: prefix.key },
      });
      return { ok: true } as const;
    },
  });
}
