import type { SQL } from "bun";
import { canonicalUrl } from "../urls/index.ts";

export const MEMBER_SUGGEST_LIMIT = 8;
const QUERY = /^[\p{L}\p{N}_. -]{1,32}$/u;

export interface SuggestedMember {
  readonly id: string;
  readonly displayName: string;
  readonly url: string;
}

interface MemberRow {
  readonly id: string;
  readonly display_name: string;
}

/**
 * Prefix-matches member display names for the editor's mention autocomplete (ADR 0007).
 * Callers pass a trimmed query; an empty or malformed query returns no rows.
 */
export async function suggestMembers(
  sql: SQL,
  query: string,
  limit = MEMBER_SUGGEST_LIMIT,
): Promise<readonly SuggestedMember[]> {
  const trimmed = query.trim();

  if (!QUERY.test(trimmed)) {
    return [];
  }

  const rows = (await sql`
    SELECT id::text AS id, display_name
    FROM core.members
    WHERE is_service = false
      AND display_name IS NOT NULL
      AND starts_with(lower(display_name), lower(${trimmed}))
    ORDER BY lower(display_name), id
    LIMIT ${Math.min(Math.max(limit, 1), MEMBER_SUGGEST_LIMIT)}
  `) as MemberRow[];

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    url: canonicalUrl("profile", row.id, row.display_name),
  }));
}
