import type { SQL } from "bun";
import { emit } from "../events/outbox.ts";
import { moderatedForums } from "../moderation/queue/repository.ts";
import { can } from "../permissions/can.ts";
import type { ForumTree } from "../permissions/tree.ts";
import { loadForumTree } from "../permissions/tree-store.ts";
import { readPostContext } from "../topics/reading/repository.ts";

export const REPORT_REASONS = ["spam", "abuse", "harassment", "off_topic", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ["open", "in_progress", "resolved", "rejected"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_TARGET_TYPES = ["post", "member", "pm"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

const CLOSED_STATUSES: readonly ReportStatus[] = ["resolved", "rejected"];

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === "string" && (REPORT_REASONS as readonly string[]).includes(value);
}

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === "string" && (REPORT_STATUSES as readonly string[]).includes(value);
}

export function isReportTargetType(value: unknown): value is ReportTargetType {
  return typeof value === "string" && (REPORT_TARGET_TYPES as readonly string[]).includes(value);
}

export interface ReportAccess {
  /** Forums whose post reports the actor may triage. */
  readonly forumIds: readonly string[];
  readonly members: boolean;
  readonly pms: boolean;
  readonly any: boolean;
}

export async function reportAccess(
  sql: SQL,
  actorId: string,
  sessionId: string | null = null,
  tree?: ForumTree,
): Promise<ReportAccess> {
  const loadedTree = tree ?? (await loadForumTree(sql));
  const forumIds = (await moderatedForums(sql, actorId, sessionId, loadedTree)).map(
    (forum) => forum.id,
  );
  const [members, pms] = await Promise.all([
    can(sql, actorId, "reports.members"),
    can(sql, actorId, "reports.pms"),
  ]);

  return {
    forumIds,
    members,
    pms,
    any: forumIds.length > 0 || members || pms,
  };
}

export type ReportOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly code:
        | "not_found"
        | "forbidden"
        | "invalid_request"
        | "already_reported"
        | "invalid_reason"
        | "invalid_status";
    };

export interface ReporterRecord {
  readonly memberId: string;
  readonly memberName: string | null;
  readonly reason: ReportReason;
  readonly comment: string;
  readonly createdAt: Date;
}

export interface ReportCommentRecord {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly body: string;
  readonly createdAt: Date;
}

export interface ReportSubject {
  readonly label: string;
  readonly href: string | null;
}

export interface ReportListItem {
  readonly id: string;
  readonly targetType: ReportTargetType;
  readonly targetId: string;
  readonly status: ReportStatus;
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly subject: ReportSubject;
  readonly reporters: readonly ReporterRecord[];
  readonly comments: readonly ReportCommentRecord[];
}

export interface ReportPage {
  readonly reports: readonly ReportListItem[];
  readonly total: number;
}

interface ReportRow {
  readonly id: string;
  readonly target_type: ReportTargetType;
  readonly target_id: string;
  readonly status: ReportStatus;
  readonly assignee_id: string | null;
  readonly assignee_name: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly topic_title: string | null;
  readonly topic_id: string | null;
  readonly topic_slug: string | null;
  readonly member_name: string | null;
}

function subjectOf(row: ReportRow): ReportSubject {
  if (row.target_type === "post") {
    return {
      label: row.topic_title ?? "",
      href:
        row.topic_id === null || row.topic_slug === null
          ? null
          : `/topic/${row.topic_id}-${row.topic_slug}/post/${row.target_id}`,
    };
  }

  if (row.target_type === "member") {
    return { label: row.member_name ?? "", href: null };
  }

  return { label: "", href: null };
}

async function reportersFor(
  sql: SQL,
  reportIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ReporterRecord[]>> {
  if (reportIds.length === 0) {
    return new Map();
  }

  const rows = (await sql`
    SELECT rr.report_id::text AS report_id, rr.reporter_id::text AS member_id,
      m.display_name AS member_name, rr.reason, rr.comment, rr.created_at
    FROM core.report_reporters rr
    LEFT JOIN core.members m ON m.id = rr.reporter_id
    WHERE rr.report_id = ANY(${`{${reportIds.join(",")}}`}::bigint[])
    ORDER BY rr.created_at, rr.reporter_id
  `) as Array<{
    report_id: string;
    member_id: string;
    member_name: string | null;
    reason: ReportReason;
    comment: string;
    created_at: Date;
  }>;
  const grouped = new Map<string, ReporterRecord[]>();

  for (const row of rows) {
    const list = grouped.get(row.report_id) ?? [];
    list.push({
      memberId: row.member_id,
      memberName: row.member_name,
      reason: row.reason,
      comment: row.comment,
      createdAt: row.created_at,
    });
    grouped.set(row.report_id, list);
  }

  return grouped;
}

async function commentsFor(
  sql: SQL,
  reportIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ReportCommentRecord[]>> {
  if (reportIds.length === 0) {
    return new Map();
  }

  const rows = (await sql`
    SELECT c.report_id::text AS report_id, c.id::text AS id, c.actor_id::text AS actor_id,
      actor.display_name AS actor_name, c.body, c.created_at
    FROM core.report_comments c
    LEFT JOIN core.members actor ON actor.id = c.actor_id
    WHERE c.report_id = ANY(${`{${reportIds.join(",")}}`}::bigint[])
    ORDER BY c.id
  `) as Array<{
    report_id: string;
    id: string;
    actor_id: string | null;
    actor_name: string | null;
    body: string;
    created_at: Date;
  }>;
  const grouped = new Map<string, ReportCommentRecord[]>();

  for (const row of rows) {
    const list = grouped.get(row.report_id) ?? [];
    list.push({
      id: row.id,
      actorId: row.actor_id,
      actorName: row.actor_name,
      body: row.body,
      createdAt: row.created_at,
    });
    grouped.set(row.report_id, list);
  }

  return grouped;
}

/** Reports the actor may see, newest first; PM bodies are never part of a list row. */
export async function listReports(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly sessionId?: string | null;
    readonly status?: ReportStatus | null;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<ReportPage> {
  const tree = await loadForumTree(sql);
  const access = await reportAccess(sql, input.actorId, input.sessionId ?? null, tree);

  if (!access.any) {
    return { reports: [], total: 0 };
  }

  const allowedForums = access.forumIds.join(",");
  const statusFilter =
    input.status === undefined || input.status === null
      ? sql`TRUE`
      : sql`r.status = ${input.status}`;
  const rows = (await sql`
    SELECT r.id::text AS id, r.target_type, r.target_id::text AS target_id, r.status,
      r.assignee_id::text AS assignee_id, assignee.display_name AS assignee_name,
      r.created_at, r.updated_at,
      t.title AS topic_title, t.id::text AS topic_id, t.slug AS topic_slug,
      target_member.display_name AS member_name
    FROM core.reports r
    LEFT JOIN core.members assignee ON assignee.id = r.assignee_id
    LEFT JOIN core.posts p ON r.target_type = 'post' AND p.id = r.target_id
    LEFT JOIN core.topics t ON t.id = p.topic_id
    LEFT JOIN core.members target_member
      ON r.target_type = 'member' AND target_member.id = r.target_id
    WHERE (
      (${access.forumIds.length > 0} AND r.target_type = 'post' AND EXISTS (
        SELECT 1 FROM core.posts rp
        JOIN core.topics rt ON rt.id = rp.topic_id
        WHERE rp.id = r.target_id
          AND rt.forum_id = ANY(${`{${allowedForums}}`}::bigint[])
      ))
      OR (${access.members} AND r.target_type = 'member')
      OR (${access.pms} AND r.target_type = 'pm')
    )
      AND ${statusFilter}
    ORDER BY r.updated_at DESC, r.id DESC
    LIMIT ${input.limit} OFFSET ${input.offset}
  `) as ReportRow[];
  const [count] = (await sql`
    SELECT count(*)::int AS count
    FROM core.reports r
    WHERE (
      (${access.forumIds.length > 0} AND r.target_type = 'post' AND EXISTS (
        SELECT 1 FROM core.posts rp
        JOIN core.topics rt ON rt.id = rp.topic_id
        WHERE rp.id = r.target_id
          AND rt.forum_id = ANY(${`{${allowedForums}}`}::bigint[])
      ))
      OR (${access.members} AND r.target_type = 'member')
      OR (${access.pms} AND r.target_type = 'pm')
    )
      AND ${statusFilter}
  `) as Array<{ count: number }>;

  const ids = rows.map((row) => row.id);
  const [reporters, comments] = await Promise.all([reportersFor(sql, ids), commentsFor(sql, ids)]);

  return {
    reports: rows.map((row) => ({
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      status: row.status,
      assigneeId: row.assignee_id,
      assigneeName: row.assignee_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      subject: subjectOf(row),
      reporters: reporters.get(row.id) ?? [],
      comments: comments.get(row.id) ?? [],
    })),
    total: count?.count ?? 0,
  };
}

export interface PmContextMessage {
  readonly messageId: string;
  readonly authorName: string | null;
  readonly bodyHtml: string;
  readonly createdAt: Date;
  readonly reported: boolean;
}

export interface ReportDetail extends ReportListItem {
  /** Present only for a PM report whose access row exists. */
  readonly pmMessages: readonly PmContextMessage[] | null;
}

async function reportRow(sql: SQL, reportId: string): Promise<ReportRow | null> {
  const rows = (await sql`
    SELECT r.id::text AS id, r.target_type, r.target_id::text AS target_id, r.status,
      r.assignee_id::text AS assignee_id, assignee.display_name AS assignee_name,
      r.created_at, r.updated_at,
      t.title AS topic_title, t.id::text AS topic_id, t.slug AS topic_slug,
      target_member.display_name AS member_name
    FROM core.reports r
    LEFT JOIN core.members assignee ON assignee.id = r.assignee_id
    LEFT JOIN core.posts p ON r.target_type = 'post' AND p.id = r.target_id
    LEFT JOIN core.topics t ON t.id = p.topic_id
    LEFT JOIN core.members target_member
      ON r.target_type = 'member' AND target_member.id = r.target_id
    WHERE r.id = ${reportId}
  `) as ReportRow[];

  return rows[0] ?? null;
}

async function canSeeReport(
  sql: SQL,
  access: ReportAccess,
  row: ReportRow,
  actorId: string,
  sessionId: string | null,
  tree: ForumTree,
): Promise<boolean> {
  if (row.target_type === "member") {
    return access.members;
  }

  if (row.target_type === "pm") {
    return access.pms;
  }

  const target = (await sql`
    SELECT t.forum_id::text AS forum_id
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ${row.target_id}
  `) as Array<{ forum_id: string }>;
  const forumId = target[0]?.forum_id;

  if (forumId === undefined) {
    return false;
  }

  return (
    access.forumIds.includes(forumId) ||
    (await can(sql, actorId, "read", { forumId, tree, sessionId }))
  );
}

async function pmMessagesFor(sql: SQL, report: ReportRow): Promise<readonly PmContextMessage[]> {
  const rows = (await sql`
    SELECT m.id::text AS message_id, author.display_name AS author_name,
      m.body_html, m.created_at
    FROM core.report_pm_access a
    JOIN core.conversation_messages m ON m.id = a.message_id
    LEFT JOIN core.members author ON author.id = m.author_id
    WHERE a.report_id = ${report.id}
    ORDER BY a.position, m.id
  `) as Array<{
    message_id: string;
    author_name: string | null;
    body_html: string;
    created_at: Date;
  }>;

  return rows.map((row) => ({
    messageId: row.message_id,
    authorName: row.author_name,
    bodyHtml: row.body_html,
    createdAt: row.created_at,
    reported: row.message_id === report.target_id,
  }));
}

async function recordPmView(
  sql: SQL,
  actorId: string,
  report: ReportRow,
  messageIds: readonly string[],
): Promise<void> {
  await sql`
    INSERT INTO core.moderation_log (
      actor_member_id, action, target_type, target_id, summary
    )
    VALUES (
      ${actorId}, 'report.pm_access', 'report', ${report.id},
      ${{ reportId: report.id, messageIds }}::jsonb
    )
  `;
}

/** One report with its PM context. Reading PM context writes the audit row first. */
export async function readReportDetail(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly reportId: string;
    readonly sessionId?: string | null;
  },
): Promise<ReportOutcome<ReportDetail>> {
  if (!/^\d+$/.test(input.reportId)) {
    return { ok: false, code: "not_found" };
  }

  const tree = await loadForumTree(sql);
  const access = await reportAccess(sql, input.actorId, input.sessionId ?? null, tree);

  return sql.begin(async (tx) => {
    const report = await reportRow(tx, input.reportId);

    if (report === null) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (!(await canSeeReport(tx, access, report, input.actorId, input.sessionId ?? null, tree))) {
      return { ok: false as const, code: "forbidden" as const };
    }

    let pmMessages: readonly PmContextMessage[] | null = null;

    if (report.target_type === "pm") {
      const messages = await pmMessagesFor(tx, report);
      await recordPmView(
        tx,
        input.actorId,
        report,
        messages.map((message) => message.messageId),
      );
      pmMessages = messages;
    }

    const [reporters, comments] = await Promise.all([
      reportersFor(tx, [report.id]),
      commentsFor(tx, [report.id]),
    ]);

    return {
      ok: true as const,
      result: {
        id: report.id,
        targetType: report.target_type,
        targetId: report.target_id,
        status: report.status,
        assigneeId: report.assignee_id,
        assigneeName: report.assignee_name,
        createdAt: report.created_at,
        updatedAt: report.updated_at,
        subject: subjectOf(report),
        reporters: reporters.get(report.id) ?? [],
        comments: comments.get(report.id) ?? [],
        pmMessages,
      },
    };
  });
}

interface CreateReportInput {
  readonly actorId: string;
  readonly targetType: ReportTargetType;
  readonly targetId: string;
  readonly reason: ReportReason;
  readonly comment: string;
  readonly sessionId?: string | null;
}

interface PostTarget {
  readonly forumId: string;
  readonly topicId: string;
}

async function readPostTarget(sql: SQL, postId: string): Promise<PostTarget | null> {
  const context = await readPostContext(sql, postId);

  if (context === null || context.visibility !== "visible") {
    return null;
  }

  return { forumId: context.forumId, topicId: context.topicId };
}

async function readableTarget(
  sql: SQL,
  input: CreateReportInput,
  tree: ForumTree,
): Promise<boolean> {
  if (input.targetType === "post") {
    const target = await readPostTarget(sql, input.targetId);

    return (
      target !== null &&
      can(sql, input.actorId, "read", {
        forumId: target.forumId,
        tree,
        sessionId: input.sessionId ?? null,
      })
    );
  }

  if (input.targetType === "member") {
    const rows = (await sql`
      SELECT 1 FROM core.members WHERE id = ${input.targetId} AND state = 'active'
    `) as unknown[];

    return rows.length > 0;
  }

  const rows = (await sql`
    SELECT 1
    FROM core.conversation_messages m
    JOIN core.conversation_participants p
      ON p.conversation_id = m.conversation_id
     AND p.member_id = ${input.actorId}
     AND p.state = 'active'
    WHERE m.id = ${input.targetId}
  `) as unknown[];

  return rows.length > 0;
}

interface PmMessageRow {
  readonly id: string;
  readonly conversation_id: string;
}

async function pmContext(
  sql: SQL,
  messageId: string,
  actorId: string,
): Promise<readonly PmMessageRow[]> {
  const target = (await sql`
    SELECT m.id::text AS id, m.conversation_id::text AS conversation_id
    FROM core.conversation_messages m
    JOIN core.conversation_participants p
      ON p.conversation_id = m.conversation_id
     AND p.member_id = ${actorId}
     AND p.state = 'active'
    WHERE m.id = ${messageId}
  `) as PmMessageRow[];
  const message = target[0];

  if (message === undefined) {
    return [];
  }

  const rows = (await sql`
    SELECT id::text AS id, conversation_id::text AS conversation_id
    FROM (
      SELECT id, conversation_id
      FROM core.conversation_messages
      WHERE conversation_id = ${message.conversation_id}
        AND id <= ${message.id}
      ORDER BY id DESC
      LIMIT 6
    ) recent
    ORDER BY id
  `) as PmMessageRow[];

  return rows;
}

async function insertPmHolds(
  tx: SQL,
  reportId: string,
  messages: readonly PmMessageRow[],
): Promise<void> {
  for (const [position, message] of messages.entries()) {
    await tx`
      INSERT INTO core.report_pm_access (report_id, message_id, position)
      VALUES (${reportId}, ${message.id}, ${position})
      ON CONFLICT DO NOTHING
    `;
    await tx`
      INSERT INTO core.conversation_message_holds (message_id, holder, ref)
      VALUES (${message.id}, 'report', ${reportId})
      ON CONFLICT DO NOTHING
    `;
  }
}

/** Creates a report, or adds the reporter to the already-open report for the same target. */
export async function createReport(
  sql: SQL,
  input: CreateReportInput,
): Promise<ReportOutcome<{ readonly reportId: string }>> {
  if (!/^\d+$/.test(input.targetId) || input.comment.length > 2_000) {
    return { ok: false, code: "invalid_request" };
  }

  const tree = await loadForumTree(sql);

  if (!(await readableTarget(sql, input, tree))) {
    return { ok: false, code: "not_found" };
  }

  const pmMessages =
    input.targetType === "pm" ? await pmContext(sql, input.targetId, input.actorId) : [];

  if (input.targetType === "pm" && pmMessages.length === 0) {
    return { ok: false, code: "not_found" };
  }

  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`bulletin.report:${input.targetType}:${input.targetId}`})::bigint)`;
      const open = (await tx`
        SELECT id::text AS id
        FROM core.reports
        WHERE target_type = ${input.targetType}
          AND target_id = ${input.targetId}
          AND status IN ('open', 'in_progress')
        FOR UPDATE
      `) as Array<{ id: string }>;
      const existing = open[0];
      let reportId = existing?.id;

      if (reportId === undefined) {
        const [created] = (await tx`
          INSERT INTO core.reports (target_type, target_id)
          VALUES (${input.targetType}, ${input.targetId})
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (created === undefined) {
          throw new Error("Could not create the report");
        }

        reportId = created.id;
      }

      const reporter = (await tx`
        INSERT INTO core.report_reporters (report_id, reporter_id, reason, comment)
        VALUES (${reportId}, ${input.actorId}, ${input.reason}, ${input.comment})
        ON CONFLICT (report_id, reporter_id) DO NOTHING
        RETURNING 1
      `) as unknown[];

      if (reporter.length === 0) {
        return { ok: false as const, code: "already_reported" as const };
      }

      if (input.targetType === "pm") {
        await insertPmHolds(tx, reportId, pmMessages);
      }

      await tx`UPDATE core.reports SET updated_at = now() WHERE id = ${reportId}`;

      return { ok: true as const, result: { reportId } };
    });
  } catch (error) {
    // A concurrent create for the same target may win the unique open-report index.
    if (error instanceof Error && error.message.includes("reports_open_target_key")) {
      return { ok: false, code: "already_reported" };
    }

    throw error;
  }
}

export type ReportAction =
  | { readonly kind: "status"; readonly status: ReportStatus }
  | { readonly kind: "assign"; readonly assign: boolean }
  | { readonly kind: "comment"; readonly body: string };

/** Status, assignment and comments in one guarded mutation. Closing releases PM holds. */
export async function updateReport(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly reportId: string;
    readonly action: ReportAction;
    readonly sessionId?: string | null;
  },
): Promise<ReportOutcome<ReportDetail>> {
  if (!/^\d+$/.test(input.reportId)) {
    return { ok: false, code: "not_found" };
  }

  if (input.action.kind === "comment" && input.action.body.trim() === "") {
    return { ok: false, code: "invalid_request" };
  }

  const tree = await loadForumTree(sql);
  const access = await reportAccess(sql, input.actorId, input.sessionId ?? null, tree);

  return sql.begin(async (tx) => {
    const report = (await tx`
      SELECT id::text AS id, target_type, target_id::text AS target_id, status,
        assignee_id::text AS assignee_id, NULL::text AS assignee_name,
        created_at, updated_at,
        NULL::text AS topic_title, NULL::text AS topic_id, NULL::text AS topic_slug,
        NULL::text AS member_name
      FROM core.reports
      WHERE id = ${input.reportId}
      FOR UPDATE
    `) as ReportRow[];
    const current = report[0];

    if (current === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (!(await canSeeReport(tx, access, current, input.actorId, input.sessionId ?? null, tree))) {
      return { ok: false as const, code: "forbidden" as const };
    }

    if (input.action.kind === "status") {
      if (!isReportStatus(input.action.status)) {
        return { ok: false as const, code: "invalid_status" as const };
      }

      const closing =
        CLOSED_STATUSES.includes(input.action.status) && !CLOSED_STATUSES.includes(current.status);

      await tx`
        UPDATE core.reports
        SET status = ${input.action.status},
            resolved_at = CASE WHEN ${CLOSED_STATUSES.includes(input.action.status)}
              THEN now() ELSE NULL END,
            updated_at = now()
        WHERE id = ${current.id}
      `;

      if (closing) {
        await tx`
          DELETE FROM core.conversation_message_holds
          WHERE holder = 'report' AND ref = ${current.id}
        `;
        await tx`DELETE FROM core.report_pm_access WHERE report_id = ${current.id}`;

        const reporters = (await tx`
          SELECT reporter_id::text AS id FROM core.report_reporters WHERE report_id = ${current.id}
        `) as Array<{ id: string }>;

        for (const reporter of reporters) {
          await emit(tx, {
            type: input.action.status === "resolved" ? "report.resolved" : "report.rejected",
            aggregateId: BigInt(current.id),
            aggregateVersion: 1n,
            payloadIds: {
              reportId: BigInt(current.id),
              reporterId: BigInt(reporter.id),
              actorId: BigInt(input.actorId),
            },
          });
        }
      }
    } else if (input.action.kind === "assign") {
      await tx`
        UPDATE core.reports
        SET assignee_id = ${input.action.assign ? input.actorId : null}, updated_at = now()
        WHERE id = ${current.id}
      `;
    } else {
      await tx`
        INSERT INTO core.report_comments (report_id, actor_id, body)
        VALUES (${current.id}, ${input.actorId}, ${input.action.body.trim()})
      `;
      await tx`UPDATE core.reports SET updated_at = now() WHERE id = ${current.id}`;
    }

    const updated = await reportRow(tx, current.id);

    if (updated === null) {
      throw new Error("Report disappeared during update");
    }

    const [reporters, comments] = await Promise.all([
      reportersFor(tx, [updated.id]),
      commentsFor(tx, [updated.id]),
    ]);

    return {
      ok: true as const,
      result: {
        id: updated.id,
        targetType: updated.target_type,
        targetId: updated.target_id,
        status: updated.status,
        assigneeId: updated.assignee_id,
        assigneeName: updated.assignee_name,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
        subject: subjectOf(updated),
        reporters: reporters.get(updated.id) ?? [],
        comments: comments.get(updated.id) ?? [],
        pmMessages: null,
      },
    };
  });
}
