import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import type { ViewerPrincipal } from "../permissions/principal.ts";

export interface MemberSearchInput {
  readonly query: string;
  readonly limit?: number;
}

export interface MemberSearchHit {
  readonly id: string;
  readonly displayName: string;
  readonly avatarHash: string | null;
  readonly groupTitle: string | null;
  readonly groupColour: string | null;
  readonly score: number;
}

const MEMBER_SEARCH_LIMIT = 10;
const MAX_LIMIT = 50;

interface MemberSearchRow {
  readonly id: string;
  readonly display_name: string;
  readonly avatar_hash: string | null;
  readonly group_title: string | null;
  readonly group_colour: string | null;
  readonly score: number;
}

/**
 * Trigram member search (ADR 0017): prefix matches first, then substring, then close typos.
 * The member-list opt-out is applied in SQL; `includeHidden` is only true after `can()` says
 * the viewer has `members.view_hidden`.
 */
export async function searchMembers(
  sql: SQL,
  principal: ViewerPrincipal,
  input: MemberSearchInput,
): Promise<readonly MemberSearchHit[]> {
  const query = input.query.trim().slice(0, 80);

  if (query === "") {
    return [];
  }

  const includeHidden = await can(sql, principal, "members.view_hidden");
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? MEMBER_SEARCH_LIMIT));
  const rows = (await sql`
    SELECT
      member.id::text AS id,
      member.display_name,
      member.avatar_hash,
      member_group.title AS group_title,
      member_group.name_colour AS group_colour,
      similarity(lower(member.display_name), lower(${query}))::float8 AS score
    FROM core.members AS member
    LEFT JOIN core.member_groups AS membership
      ON membership.member_id = member.id AND membership.is_primary
    LEFT JOIN core.groups AS member_group ON member_group.id = membership.group_id
    WHERE member.display_name IS NOT NULL
      AND member.is_service = false
      AND member.state = 'active'
      AND (${includeHidden} OR NOT member.hide_from_member_list)
      AND (
        lower(member.display_name) LIKE lower(${query}) || '%'
        OR lower(member.display_name) LIKE '%' || lower(${query}) || '%'
        OR similarity(lower(member.display_name), lower(${query})) > 0.1
      )
    ORDER BY
      CASE
        WHEN lower(member.display_name) LIKE lower(${query}) || '%' THEN 0
        WHEN lower(member.display_name) LIKE '%' || lower(${query}) || '%' THEN 1
        ELSE 2
      END,
      similarity(lower(member.display_name), lower(${query})) DESC,
      member.display_name ASC,
      member.id ASC
    LIMIT ${limit}
  `) as MemberSearchRow[];

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    avatarHash: row.avatar_hash,
    groupTitle: row.group_title,
    groupColour: row.group_colour,
    score: row.score,
  }));
}
