import type { SQL } from "bun";

export const MEMBER_LIST_SORTS = ["name", "joined", "posts", "reputation"] as const;
export type MemberListSort = (typeof MEMBER_LIST_SORTS)[number];

export const MEMBER_LIST_DIRECTIONS = ["asc", "desc"] as const;
export type MemberListDirection = (typeof MEMBER_LIST_DIRECTIONS)[number];

export const MEMBER_LIST_PAGE_SIZE = 24;

const SORT_SET = new Set<string>(MEMBER_LIST_SORTS);
const DIRECTION_SET = new Set<string>(MEMBER_LIST_DIRECTIONS);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function memberListSort(value: string | null): MemberListSort {
  return value !== null && SORT_SET.has(value) ? (value as MemberListSort) : "name";
}

export function memberListDirection(value: string | null): MemberListDirection {
  return value !== null && DIRECTION_SET.has(value) ? (value as MemberListDirection) : "asc";
}

export function memberListDate(value: string | null): string | null {
  return value !== null && DATE.test(value) ? value : null;
}

export function memberListPage(value: string | null): number {
  if (value === null || !/^\d{1,6}$/.test(value)) {
    return 1;
  }

  return Math.max(1, Number(value));
}

export interface MemberListInput {
  readonly query: string;
  readonly groupId: string | null;
  readonly joinedFrom: string | null;
  readonly joinedTo: string | null;
  readonly sort: MemberListSort;
  readonly direction: MemberListDirection;
  readonly page: number;
  /** Staff with `members.view_hidden` also see members who opted out of the list. */
  readonly includeHidden: boolean;
}

export interface MemberListEntry {
  readonly id: string;
  readonly displayName: string;
  readonly avatarHash: string | null;
  readonly groupTitle: string | null;
  readonly groupColour: string | null;
  readonly joinedAt: Date;
  readonly postCount: number;
  readonly reputation: number;
}

export interface MemberListPage {
  readonly members: readonly MemberListEntry[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
}

interface MemberListRow {
  readonly id: string;
  readonly display_name: string;
  readonly avatar_hash: string | null;
  readonly group_title: string | null;
  readonly group_colour: string | null;
  readonly joined_at: Date;
  readonly post_count: number;
  readonly reputation: number;
}

/** Raw member-list SQL; authorisation and hidden-member opt-out are applied in the where. */
export async function listMembers(sql: SQL, input: MemberListInput): Promise<MemberListPage> {
  const query = input.query.trim().slice(0, 80);
  const groupId = input.groupId !== null && /^\d+$/.test(input.groupId) ? input.groupId : null;
  const from = memberListDate(input.joinedFrom);
  const to = memberListDate(input.joinedTo);
  const conditions = sql`
    m.display_name IS NOT NULL
      AND m.is_service = false
      AND m.state = 'active'
      AND (${query} = '' OR m.display_name ILIKE ${`%${query}%`})
      AND (
        ${groupId}::bigint IS NULL
        OR EXISTS (
          SELECT 1 FROM core.member_groups filter_group
          WHERE filter_group.member_id = m.id AND filter_group.group_id = ${groupId}
        )
      )
      AND (${from}::date IS NULL OR m.joined_at >= ${from}::date)
      AND (${to}::date IS NULL OR m.joined_at < ${to}::date + interval '1 day')
      AND (${input.includeHidden} OR NOT m.hide_from_member_list)
  `;
  const [countRow] = (await sql`
    SELECT count(*)::int AS count FROM core.members m WHERE ${conditions}
  `) as Array<{ count: number }>;
  const total = countRow?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / MEMBER_LIST_PAGE_SIZE));
  const page = Math.min(input.page, pageCount);
  const direction = input.direction === "desc" ? "DESC" : "ASC";
  const rows = (await sql`
    SELECT
      m.id::text AS id,
      m.display_name,
      m.avatar_hash,
      g.title AS group_title,
      g.name_colour AS group_colour,
      m.joined_at,
      m.post_count,
      m.reputation
    FROM core.members m
    LEFT JOIN core.member_groups mg ON mg.member_id = m.id AND mg.is_primary
    LEFT JOIN core.groups g ON g.id = mg.group_id
    WHERE ${conditions}
    ORDER BY
      CASE WHEN ${input.sort} = 'name' AND ${direction} = 'ASC' THEN m.display_name END ASC,
      CASE WHEN ${input.sort} = 'name' AND ${direction} = 'DESC' THEN m.display_name END DESC,
      CASE WHEN ${input.sort} = 'joined' AND ${direction} = 'ASC' THEN m.joined_at END ASC,
      CASE WHEN ${input.sort} = 'joined' AND ${direction} = 'DESC' THEN m.joined_at END DESC,
      CASE WHEN ${input.sort} = 'posts' AND ${direction} = 'ASC' THEN m.post_count END ASC,
      CASE WHEN ${input.sort} = 'posts' AND ${direction} = 'DESC' THEN m.post_count END DESC,
      CASE WHEN ${input.sort} = 'reputation' AND ${direction} = 'ASC' THEN m.reputation END ASC,
      CASE WHEN ${input.sort} = 'reputation' AND ${direction} = 'DESC' THEN m.reputation END DESC,
      m.id ASC
    LIMIT ${MEMBER_LIST_PAGE_SIZE} OFFSET ${(page - 1) * MEMBER_LIST_PAGE_SIZE}
  `) as MemberListRow[];

  return {
    page,
    pageCount,
    total,
    members: rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      avatarHash: row.avatar_hash,
      groupTitle: row.group_title,
      groupColour: row.group_colour,
      joinedAt: new Date(row.joined_at),
      postCount: row.post_count,
      reputation: row.reputation,
    })),
  };
}

export async function listMemberListGroups(
  sql: SQL,
): Promise<readonly { readonly id: string; readonly title: string }[]> {
  return (await sql`
    SELECT id::text AS id, title FROM core.groups ORDER BY display_order, id
  `) as Array<{ id: string; title: string }>;
}
