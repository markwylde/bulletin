import type { SQL } from "bun";
import { can } from "../../permissions/can.ts";
import { moderatedForums } from "../queue/repository.ts";

export interface ModerationLogInput {
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly forumId?: string | null;
  readonly memberId?: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Append-only write helper; the table grants expose INSERT and SELECT only. */
export async function writeModerationLog(sql: SQL, input: ModerationLogInput): Promise<void> {
  await sql`
    INSERT INTO core.moderation_log (
      actor_member_id, action, target_type, target_id, forum_id, member_id, summary
    )
    VALUES (
      ${input.actorId}, ${input.action}, ${input.targetType}, ${input.targetId},
      ${input.forumId ?? null}, ${input.memberId ?? null},
      (${JSON.stringify(input.details ?? {})}::text)::jsonb
    )
  `;
}

export interface ModerationLogEntry {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly forumId: string | null;
  readonly forumTitle: string | null;
  readonly memberId: string | null;
  readonly memberName: string | null;
  readonly details: unknown;
  readonly createdAt: Date;
}

export interface ModerationLogFilters {
  readonly actorId?: string | null;
  readonly action?: string | null;
  readonly forumId?: string | null;
  readonly memberId?: string | null;
  readonly from?: Date | null;
  readonly to?: Date | null;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ModerationLogPage {
  readonly entries: readonly ModerationLogEntry[];
  readonly total: number;
  /** False means the viewer may not read any log entries. */
  readonly allowed: boolean;
}

async function logScope(
  sql: SQL,
  actorId: string,
  sessionId: string | null,
): Promise<{ readonly full: boolean; readonly forumIds: readonly string[] }> {
  const full = await can(sql, actorId, "acp.log");
  const forumIds = full
    ? []
    : (await moderatedForums(sql, actorId, sessionId)).map((forum) => forum.id);

  return { full, forumIds };
}

export async function canViewModerationLog(
  sql: SQL,
  actorId: string,
  sessionId: string | null = null,
): Promise<boolean> {
  const scope = await logScope(sql, actorId, sessionId);
  return scope.full || scope.forumIds.length > 0;
}

/** Admins see everything; forum moderators see only entries tagged with their forums. */
export async function listModerationLog(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly sessionId?: string | null;
    readonly filters?: ModerationLogFilters;
  },
): Promise<ModerationLogPage> {
  const scope = await logScope(sql, input.actorId, input.sessionId ?? null);

  if (!scope.full && scope.forumIds.length === 0) {
    return { entries: [], total: 0, allowed: false };
  }

  const filters = input.filters ?? {};
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const scopeSql = scope.full
    ? sql`TRUE`
    : sql`l.forum_id = ANY(${`{${scope.forumIds.join(",")}}`}::bigint[])`;
  const actorSql =
    filters.actorId === undefined || filters.actorId === null
      ? sql`TRUE`
      : sql`l.actor_member_id = ${filters.actorId}`;
  const actionSql =
    filters.action === undefined || filters.action === null
      ? sql`TRUE`
      : sql`l.action = ${filters.action}`;
  const forumSql =
    filters.forumId === undefined || filters.forumId === null
      ? sql`TRUE`
      : sql`l.forum_id = ${filters.forumId}`;
  const memberSql =
    filters.memberId === undefined || filters.memberId === null
      ? sql`TRUE`
      : sql`l.member_id = ${filters.memberId}`;
  const fromSql =
    filters.from === undefined || filters.from === null
      ? sql`TRUE`
      : sql`l.created_at >= ${filters.from}`;
  const toSql =
    filters.to === undefined || filters.to === null
      ? sql`TRUE`
      : sql`l.created_at <= ${filters.to}`;
  const rows = (await sql`
    SELECT l.id::text AS id, l.actor_member_id::text AS actor_id,
      actor.display_name AS actor_name, l.action, l.target_type,
      l.target_id::text AS target_id, l.forum_id::text AS forum_id,
      f.title AS forum_title, l.member_id::text AS member_id,
      member.display_name AS member_name, l.summary AS details, l.created_at
    FROM core.moderation_log l
    LEFT JOIN core.members actor ON actor.id = l.actor_member_id
    LEFT JOIN core.forums f ON f.id = l.forum_id
    LEFT JOIN core.members member ON member.id = l.member_id
    WHERE ${scopeSql} AND ${actorSql} AND ${actionSql} AND ${forumSql}
      AND ${memberSql} AND ${fromSql} AND ${toSql}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as Array<{
    id: string;
    actor_id: string | null;
    actor_name: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    forum_id: string | null;
    forum_title: string | null;
    member_id: string | null;
    member_name: string | null;
    details: unknown;
    created_at: Date;
  }>;
  const [count] = (await sql`
    SELECT count(*)::int AS count
    FROM core.moderation_log l
    WHERE ${scopeSql} AND ${actorSql} AND ${actionSql} AND ${forumSql}
      AND ${memberSql} AND ${fromSql} AND ${toSql}
  `) as Array<{ count: number }>;

  return {
    entries: rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      forumId: row.forum_id,
      forumTitle: row.forum_title,
      memberId: row.member_id,
      memberName: row.member_name,
      details: row.details,
      createdAt: row.created_at,
    })),
    total: count?.count ?? 0,
    allowed: true,
  };
}
