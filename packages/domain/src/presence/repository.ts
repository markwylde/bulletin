import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import type { ViewerPrincipal } from "../permissions/principal.ts";
import type { PermissionSnapshot } from "../permissions/snapshot.ts";
import type { ForumTree } from "../permissions/tree.ts";

/** Presence rows older than this are not "online" (design retention table, task 4.2). */
export const ONLINE_WINDOW_MS = 15 * 60 * 1_000;

export interface OnlineMember {
  readonly id: string;
  readonly displayName: string;
  readonly avatarHash: string | null;
  readonly groupTitle: string | null;
  readonly groupColour: string | null;
  /** Null when the viewer may not read the forum; the page shows "Viewing the board". */
  readonly location: string | null;
  readonly lastSeen: Date;
}

export interface OnlineOverview {
  readonly memberCount: number;
  readonly guestCount: number;
  readonly members: readonly OnlineMember[];
}

interface PresenceRow {
  readonly viewer_key: string;
  readonly location: string;
  readonly last_seen: Date;
}

interface OnlineMemberRow {
  readonly id: string;
  readonly display_name: string;
  readonly avatar_hash: string | null;
  readonly hide_online: boolean;
  readonly group_title: string | null;
  readonly group_colour: string | null;
  readonly group_order: number | null;
}

export interface OnlineOverviewInput {
  readonly now?: Date;
  readonly principal: ViewerPrincipal;
  readonly sessionId: string | null;
  readonly tree: ForumTree;
  readonly snapshot: PermissionSnapshot;
  readonly canViewHidden: boolean;
  /** Loads forum names and checks `read` for locations (the full list, task 4.2). */
  readonly withLocations?: boolean;
}

function memberKey(viewerKey: string): string | null {
  const match = /^member:(\d+)$/.exec(viewerKey);
  return match?.[1] ?? null;
}

function forumIdOf(location: string): string | null {
  const match = /^forum:(\d+)$/.exec(location);
  return match?.[1] ?? null;
}

/** Names, group styling and permission-filtered locations for everyone online now. */
export async function readOnlineOverview(
  sql: SQL,
  input: OnlineOverviewInput,
): Promise<OnlineOverview> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const presence = (await sql`
    SELECT viewer_key, location, last_seen
    FROM core.presence
    WHERE last_seen >= ${cutoff}
  `) as PresenceRow[];
  const memberIds = [
    ...new Set(
      presence.map((row) => memberKey(row.viewer_key)).filter((id): id is string => id !== null),
    ),
  ];
  const guests = presence.filter((row) => memberKey(row.viewer_key) === null).length;
  const rows =
    memberIds.length === 0
      ? []
      : ((await sql`
          SELECT
            m.id::text AS id,
            m.display_name,
            m.avatar_hash,
            m.hide_online,
            g.title AS group_title,
            g.name_colour AS group_colour,
            g.display_order AS group_order
          FROM core.members m
          LEFT JOIN core.member_groups mg ON mg.member_id = m.id AND mg.is_primary
          LEFT JOIN core.groups g ON g.id = mg.group_id
          WHERE m.id = ANY(${`{${memberIds.join(",")}}`}::bigint[])
            AND m.display_name IS NOT NULL
        `) as OnlineMemberRow[]);
  const visible = rows.filter((row) => input.canViewHidden || !row.hide_online);
  const lastSeen = new Map(presence.map((row) => [memberKey(row.viewer_key), row.last_seen]));
  const locationByMember = new Map(
    presence
      .map((row) => [memberKey(row.viewer_key), row.location] as const)
      .filter((entry): entry is readonly [string, string] => entry[0] !== null),
  );
  const forumIds = input.withLocations
    ? [
        ...new Set(
          [...locationByMember.values()].map(forumIdOf).filter((id): id is string => id !== null),
        ),
      ]
    : [];
  const forumTitles = new Map<string, string>();
  const readableForums = new Set<string>();

  if (input.withLocations) {
    for (const forumId of forumIds) {
      const allowed = await can(sql, input.principal, "read", {
        forumId,
        tree: input.tree,
        sessionId: input.sessionId,
        snapshot: input.snapshot,
      });

      if (allowed) {
        readableForums.add(forumId);
      }
    }

    if (readableForums.size > 0) {
      const titles = (await sql`
        SELECT id::text AS id, title
        FROM core.forums
        WHERE id = ANY(${`{${[...readableForums].join(",")}}`}::bigint[])
      `) as Array<{ id: string; title: string }>;

      for (const row of titles) {
        forumTitles.set(row.id, row.title);
      }
    }
  }

  const members = visible
    .map((row) => {
      const rawLocation = locationByMember.get(row.id) ?? "board";
      const forumId = forumIdOf(rawLocation);
      const location =
        input.withLocations && forumId !== null && readableForums.has(forumId)
          ? (forumTitles.get(forumId) ?? null)
          : null;

      return {
        id: row.id,
        displayName: row.display_name,
        avatarHash: row.avatar_hash,
        groupTitle: row.group_title,
        groupColour: row.group_colour,
        location,
        lastSeen: new Date(lastSeen.get(row.id) ?? now),
        groupOrder: row.group_order ?? 0,
      };
    })
    .sort((left, right) => {
      if (left.groupOrder !== right.groupOrder) {
        return left.groupOrder - right.groupOrder;
      }

      return left.displayName.localeCompare(right.displayName);
    })
    .map(({ groupOrder: _groupOrder, ...member }) => member);

  return { memberCount: visible.length, guestCount: guests, members };
}

/** The total online (members and guests) used for the board's record (task 4.3). */
export async function countOnline(sql: SQL, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const [row] = (await sql`
    SELECT count(*)::int AS count FROM core.presence WHERE last_seen >= ${cutoff}
  `) as Array<{ count: number }>;

  return row?.count ?? 0;
}

/** Raises the stored online record when the current total is higher (task 4.3). */
export async function updateOnlineRecord(
  sql: SQL,
  now: Date = new Date(),
): Promise<{ readonly count: number; readonly at: Date | null; readonly changed: boolean }> {
  const current = await countOnline(sql, now);
  const rows = (await sql`
    UPDATE core.board_settings
    SET record_online_count = ${current}, record_online_at = ${now}
    WHERE id = 1 AND (record_online_count < ${current} OR record_online_at IS NULL)
    RETURNING record_online_count, record_online_at
  `) as Array<{ record_online_count: number; record_online_at: Date | null }>;
  const row = rows[0];

  if (row !== undefined) {
    return {
      count: row.record_online_count,
      at: new Date(row.record_online_at ?? now),
      changed: true,
    };
  }

  const [existing] = (await sql`
    SELECT record_online_count, record_online_at FROM core.board_settings WHERE id = 1
  `) as Array<{ record_online_count: number; record_online_at: Date | null }>;

  return {
    count: existing?.record_online_count ?? current,
    at:
      existing?.record_online_at === null || existing?.record_online_at === undefined
        ? null
        : new Date(existing.record_online_at),
    changed: false,
  };
}
