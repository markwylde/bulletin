import type { SQL } from "bun";
import { emit } from "../events/outbox.ts";
import { can } from "../permissions/can.ts";
import type { ForumTree } from "../permissions/tree.ts";
import { loadForumTree } from "../permissions/tree-store.ts";

export const WARNING_ACTIONS = ["mod_queue", "suspend", "ban"] as const;
export type WarningAction = (typeof WARNING_ACTIONS)[number];

export function isWarningAction(value: unknown): value is WarningAction {
  return typeof value === "string" && (WARNING_ACTIONS as readonly string[]).includes(value);
}

export interface WarningReasonRecord {
  readonly id: string;
  readonly key: string;
  readonly points: number;
  readonly expiryDays: number;
  readonly allowPointsOverride: boolean;
  readonly enabled: boolean;
  readonly position: number;
  readonly labels: Readonly<Record<string, string>>;
}

export interface WarningThresholdRecord {
  readonly id: string;
  readonly points: number;
  readonly action: WarningAction;
  readonly durationHours: number | null;
}

export interface WarningRecord {
  readonly id: string;
  readonly memberId: string;
  readonly reasonId: string | null;
  readonly reasonKey: string | null;
  readonly reasonLabel: string;
  readonly points: number;
  readonly expiresAt: Date;
  readonly expiredAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
  readonly contentType: "post" | "member" | null;
  readonly contentId: string | null;
  readonly memberNote: string;
  readonly staffNote: string;
  readonly ackRequired: boolean;
  readonly ackedAt: Date | null;
  readonly issuedBy: string | null;
  readonly createdAt: Date;
}

export interface MemberRestriction {
  readonly kind: "posts_require_approval" | "cannot_post" | "banned";
  readonly until: Date | null;
}

export type WarningOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly code:
        | "forbidden"
        | "not_found"
        | "invalid_request"
        | "reason_not_found"
        | "invalid_threshold"
        | "duplicate_reason";
    };

interface ReasonRowSql {
  readonly id: string;
  readonly key: string;
  readonly points: number;
  readonly expiry_days: number;
  readonly allow_points_override: boolean;
  readonly enabled: boolean;
  readonly position: number;
  readonly labels: Readonly<Record<string, string>> | null;
}

function reasonRecord(row: ReasonRowSql): WarningReasonRecord {
  return {
    id: row.id,
    key: row.key,
    points: row.points,
    expiryDays: row.expiry_days,
    allowPointsOverride: row.allow_points_override,
    enabled: row.enabled,
    position: row.position,
    labels: row.labels ?? {},
  };
}

export async function listWarningReasons(
  sql: SQL,
  options: { readonly enabledOnly?: boolean } = {},
): Promise<readonly WarningReasonRecord[]> {
  const rows = (await sql`
    SELECT r.id::text AS id, r.key, r.points, r.expiry_days, r.allow_points_override,
      r.enabled, r.position,
      COALESCE(
        (SELECT jsonb_object_agg(l.locale, l.label) FROM core.warning_reason_labels l
         WHERE l.reason_id = r.id),
        '{}'::jsonb
      ) AS labels
    FROM core.warning_reasons r
    WHERE (${options.enabledOnly === true} = false OR r.enabled)
    ORDER BY r.position, r.id
  `) as ReasonRowSql[];

  return rows.map(reasonRecord);
}

export async function listWarningThresholds(sql: SQL): Promise<readonly WarningThresholdRecord[]> {
  const rows = (await sql`
    SELECT id::text AS id, points, action, duration_hours
    FROM core.warning_thresholds ORDER BY points, id
  `) as Array<{
    id: string;
    points: number;
    action: WarningAction;
    duration_hours: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    points: row.points,
    action: row.action,
    durationHours: row.duration_hours,
  }));
}

function labelValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= 120
    ? value.trim()
    : null;
}

export async function saveWarningReason(
  sql: SQL,
  input: unknown,
): Promise<WarningOutcome<{ readonly id: string }>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, code: "invalid_request" };
  }

  const record = input as Record<string, unknown>;
  const key = typeof record.key === "string" ? record.key : "";
  const labels = record.labels;

  if (!/^[a-z][a-z0-9_]*$/.test(key) || typeof labels !== "object" || labels === null) {
    return { ok: false, code: "invalid_request" };
  }

  const labelRecord = labels as Record<string, unknown>;
  const english = labelValue(labelRecord.en);

  if (english === null) {
    return { ok: false, code: "invalid_request" };
  }

  const points =
    typeof record.points === "number" && Number.isInteger(record.points) && record.points >= 0
      ? record.points
      : null;
  const expiryDays =
    typeof record.expiryDays === "number" &&
    Number.isInteger(record.expiryDays) &&
    record.expiryDays >= 0 &&
    record.expiryDays <= 3_650
      ? record.expiryDays
      : null;

  if (points === null || points > 1_000 || expiryDays === null) {
    return { ok: false, code: "invalid_request" };
  }

  const position =
    typeof record.position === "number" && Number.isInteger(record.position) && record.position >= 0
      ? record.position
      : 0;
  const allowPointsOverride = record.allowPointsOverride === true;
  const enabled = record.enabled !== false;

  try {
    return await sql.begin(async (tx) => {
      let reasonId: string | undefined;

      if (typeof record.id === "string" && /^\d+$/.test(record.id)) {
        const rows = (await tx`
          UPDATE core.warning_reasons
          SET key = ${key}, points = ${points}, expiry_days = ${expiryDays},
              allow_points_override = ${allowPointsOverride}, position = ${position},
              enabled = ${enabled}, updated_at = now()
          WHERE id = ${record.id}
          RETURNING id::text AS id
        `) as Array<{ id: string }>;
        reasonId = rows[0]?.id;
      } else {
        const rows = (await tx`
          INSERT INTO core.warning_reasons (
            key, points, expiry_days, allow_points_override, position, enabled
          )
          VALUES (${key}, ${points}, ${expiryDays}, ${allowPointsOverride}, ${position}, ${enabled})
          RETURNING id::text AS id
        `) as Array<{ id: string }>;
        reasonId = rows[0]?.id;
      }

      if (reasonId === undefined) {
        return { ok: false as const, code: "not_found" as const };
      }

      await tx`DELETE FROM core.warning_reason_labels WHERE reason_id = ${reasonId}`;

      for (const locale of ["en", "es", "fr"] as const) {
        const label = labelValue(labelRecord[locale]) ?? english;
        await tx`
          INSERT INTO core.warning_reason_labels (reason_id, locale, label)
          VALUES (${reasonId}, ${locale}, ${label})
        `;
      }

      return { ok: true as const, result: { id: reasonId } };
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("warning_reasons_key_key")) {
      return { ok: false, code: "duplicate_reason" };
    }

    throw error;
  }
}

export async function deleteWarningReason(
  sql: SQL,
  reasonId: string,
): Promise<WarningOutcome<{ readonly deleted: boolean }>> {
  if (!/^\d+$/.test(reasonId)) {
    return { ok: false, code: "not_found" };
  }

  const rows = (await sql`
    DELETE FROM core.warning_reasons WHERE id = ${reasonId} RETURNING 1
  `) as unknown[];

  return { ok: true, result: { deleted: rows.length > 0 } };
}

export async function saveWarningThreshold(
  sql: SQL,
  input: unknown,
): Promise<WarningOutcome<{ readonly id: string }>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, code: "invalid_request" };
  }

  const record = input as Record<string, unknown>;
  const points = record.points;
  const action = record.action;
  const durationHours = record.durationHours;

  if (
    typeof points !== "number" ||
    !Number.isInteger(points) ||
    points < 1 ||
    points > 1_000 ||
    !isWarningAction(action) ||
    (action !== "ban" &&
      (typeof durationHours !== "number" ||
        !Number.isInteger(durationHours) ||
        durationHours < 1 ||
        durationHours > 87_600)) ||
    (action === "ban" &&
      durationHours !== null &&
      durationHours !== undefined &&
      (typeof durationHours !== "number" ||
        !Number.isInteger(durationHours) ||
        durationHours < 1 ||
        durationHours > 87_600))
  ) {
    return { ok: false, code: "invalid_threshold" };
  }

  const duration = action === "ban" ? (durationHours ?? null) : (durationHours as number);
  const id = typeof record.id === "string" && /^\d+$/.test(record.id) ? record.id : null;
  const rows = (await (id === null
    ? sql`
        INSERT INTO core.warning_thresholds (points, action, duration_hours)
        VALUES (${points}, ${action}, ${duration})
        RETURNING id::text AS id
      `
    : sql`
        UPDATE core.warning_thresholds
        SET points = ${points}, action = ${action}, duration_hours = ${duration}
        WHERE id = ${id}
        RETURNING id::text AS id
      `)) as Array<{ id: string }>;

  return rows[0] === undefined
    ? { ok: false, code: "not_found" }
    : { ok: true, result: { id: rows[0].id } };
}

export async function deleteWarningThreshold(
  sql: SQL,
  thresholdId: string,
): Promise<WarningOutcome<{ readonly deleted: boolean }>> {
  if (!/^\d+$/.test(thresholdId)) {
    return { ok: false, code: "not_found" };
  }

  const rows = (await sql`
    DELETE FROM core.warning_thresholds WHERE id = ${thresholdId} RETURNING 1
  `) as unknown[];

  return { ok: true, result: { deleted: rows.length > 0 } };
}

interface WarningRowSql {
  readonly id: string;
  readonly member_id: string;
  readonly reason_id: string | null;
  readonly reason_key: string | null;
  readonly reason_label: string | null;
  readonly points: number;
  readonly expires_at: Date;
  readonly expired_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoke_reason: string | null;
  readonly content_type: "post" | "member" | null;
  readonly content_id: string | null;
  readonly member_note: string;
  readonly staff_note: string;
  readonly ack_required: boolean;
  readonly acked_at: Date | null;
  readonly issued_by: string | null;
  readonly created_at: Date;
}

function warningRecord(row: WarningRowSql): WarningRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    reasonId: row.reason_id,
    reasonKey: row.reason_key,
    reasonLabel: row.reason_label ?? row.reason_key ?? "",
    points: row.points,
    expiresAt: row.expires_at,
    expiredAt: row.expired_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    contentType: row.content_type,
    contentId: row.content_id,
    memberNote: row.member_note,
    staffNote: row.staff_note,
    ackRequired: row.ack_required,
    ackedAt: row.acked_at,
    issuedBy: row.issued_by,
    createdAt: row.created_at,
  };
}

async function warningRows(
  sql: SQL,
  memberId: string,
  locale: string,
  includeStaffNote: boolean,
): Promise<readonly WarningRecord[]> {
  const rows = (await sql`
    SELECT w.id::text AS id, w.member_id::text AS member_id, w.reason_id::text AS reason_id,
      r.key AS reason_key,
      COALESCE(
        (SELECT l.label FROM core.warning_reason_labels l
         WHERE l.reason_id = r.id AND l.locale = ${locale}),
        (SELECT l.label FROM core.warning_reason_labels l
         WHERE l.reason_id = r.id AND l.locale = 'en')
      ) AS reason_label,
      w.points, w.expires_at, w.expired_at, w.revoked_at, w.revoke_reason,
      w.content_type, w.content_id::text AS content_id, w.member_note,
      ${includeStaffNote ? sql`w.staff_note` : sql`''::text`} AS staff_note,
      w.ack_required, w.acked_at, w.issued_by::text AS issued_by, w.created_at
    FROM core.warnings w
    LEFT JOIN core.warning_reasons r ON r.id = w.reason_id
    WHERE w.member_id = ${memberId}
    ORDER BY w.created_at DESC, w.id DESC
  `) as WarningRowSql[];

  return rows.map(warningRecord);
}

export function listMemberWarnings(
  sql: SQL,
  memberId: string,
  locale: string,
): Promise<readonly WarningRecord[]> {
  return warningRows(sql, memberId, locale, false);
}

export function listStaffWarnings(
  sql: SQL,
  memberId: string,
  locale: string,
): Promise<readonly WarningRecord[]> {
  return warningRows(sql, memberId, locale, true);
}

export async function activeWarningPoints(
  sql: SQL,
  memberId: string,
  now: Date = new Date(),
): Promise<number> {
  const [row] = (await sql`
    SELECT COALESCE(sum(points), 0)::int AS points
    FROM core.warnings
    WHERE member_id = ${memberId}
      AND revoked_at IS NULL
      AND expires_at > ${now}
  `) as Array<{ points: number }>;

  return row?.points ?? 0;
}

export async function listMemberRestrictions(
  sql: SQL,
  memberId: string,
  now: Date = new Date(),
): Promise<readonly MemberRestriction[]> {
  const rows = (await sql`
    SELECT kind, until FROM core.member_restrictions
    WHERE member_id = ${memberId} AND (until IS NULL OR until > ${now})
    ORDER BY kind
  `) as Array<{ kind: MemberRestriction["kind"]; until: Date | null }>;

  return rows;
}

export async function hasUnacknowledgedWarning(
  sql: SQL,
  memberId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM core.warnings
    WHERE member_id = ${memberId}
      AND ack_required
      AND acked_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > ${now}
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}

/**
 * The posting gate (warnings spec): an unacknowledged warning wins over a suspension so the
 * member is sent to the warning first. A suspended member cannot start or reply.
 */
export async function postingBlockedByWarning(
  sql: SQL,
  memberId: string,
): Promise<"acknowledgement_required" | "posting_suspended" | null> {
  if (await hasUnacknowledgedWarning(sql, memberId)) {
    return "acknowledgement_required";
  }

  const allowed = await can(sql, memberId, "post");

  return allowed ? null : "posting_suspended";
}

export async function acknowledgeWarnings(sql: SQL, memberId: string): Promise<number> {
  const rows = (await sql`
    UPDATE core.warnings
    SET acked_at = now()
    WHERE member_id = ${memberId}
      AND ack_required
      AND acked_at IS NULL
      AND revoked_at IS NULL
    RETURNING id
  `) as unknown[];

  return rows.length;
}

/** Hourly sweep: stamps newly expired warnings. Active points already ignore them. */
export async function expireWarnings(sql: SQL, now: Date = new Date()): Promise<number> {
  const rows = (await sql`
    UPDATE core.warnings
    SET expired_at = now()
    WHERE expires_at <= ${now}
      AND expired_at IS NULL
      AND revoked_at IS NULL
    RETURNING id
  `) as unknown[];

  return rows.length;
}

async function canWarnAnywhere(sql: SQL, actorId: string, tree?: ForumTree): Promise<boolean> {
  const loadedTree = tree ?? (await loadForumTree(sql));

  for (const forumId of loadedTree.ids) {
    if (forumId === "0") {
      continue;
    }

    if (await can(sql, actorId, "warn", { forumId, tree: loadedTree })) {
      return true;
    }
  }

  return false;
}

/** Topic coordinates for warned posts, so the history view can link to the content. */
export async function readWarningContentTargets(
  sql: SQL,
  postIds: readonly string[],
): Promise<ReadonlyMap<string, { readonly topicId: string; readonly slug: string }>> {
  if (postIds.length === 0) {
    return new Map();
  }

  const rows = (await sql`
    SELECT p.id::text AS id, t.id::text AS topic_id, t.slug
    FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ANY(${`{${postIds.join(",")}}`}::bigint[])
  `) as Array<{ id: string; topic_id: string; slug: string }>;

  return new Map(rows.map((row) => [row.id, { topicId: row.topic_id, slug: row.slug }]));
}

export async function canViewWarningHistory(sql: SQL, actorId: string): Promise<boolean> {
  return canWarnAnywhere(sql, actorId);
}

async function contentForumId(
  sql: SQL,
  contentType: "post" | "member",
  contentId: string,
): Promise<string | null> {
  if (contentType === "member") {
    return null;
  }

  const rows = (await sql`
    SELECT t.forum_id::text AS forum_id
    FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ${contentId}
  `) as Array<{ forum_id: string }>;

  return rows[0]?.forum_id ?? null;
}

export interface IssueWarningInput {
  readonly actorId: string;
  readonly memberId: string;
  readonly reasonId: string;
  readonly points?: number;
  readonly expiryDays?: number;
  readonly contentType?: "post" | "member";
  readonly contentId?: string;
  readonly memberNote?: string;
  readonly staffNote?: string;
  readonly ackRequired?: boolean;
}

function actionRestriction(action: WarningAction): MemberRestriction["kind"] {
  switch (action) {
    case "mod_queue":
      return "posts_require_approval";
    case "suspend":
      return "cannot_post";
    case "ban":
      return "banned";
  }
}

/** Issues one warning, applies newly-crossed thresholds and notifies the member. */
export async function issueWarning(
  sql: SQL,
  input: IssueWarningInput,
): Promise<WarningOutcome<{ readonly warningId: string; readonly points: number }>> {
  if (
    !/^\d+$/.test(input.memberId) ||
    !/^\d+$/.test(input.reasonId) ||
    (input.contentId !== undefined && !/^\d+$/.test(input.contentId))
  ) {
    return { ok: false, code: "invalid_request" };
  }

  const tree = await loadForumTree(sql);
  const forumId =
    input.contentType === "post" && input.contentId !== undefined
      ? await contentForumId(sql, "post", input.contentId)
      : null;
  const allowed =
    forumId === null
      ? await canWarnAnywhere(sql, input.actorId, tree)
      : await can(sql, input.actorId, "warn", { forumId, tree });

  if (!allowed) {
    return { ok: false, code: "forbidden" };
  }

  const first = (await sql`
    SELECT id::text AS id, points, expiry_days, allow_points_override, enabled
    FROM core.warning_reasons WHERE id = ${input.reasonId}
  `) as Array<{
    id: string;
    points: number;
    expiry_days: number;
    allow_points_override: boolean;
    enabled: boolean;
  }>;
  const reason = first[0];

  if (reason === undefined || !reason.enabled) {
    return { ok: false, code: "reason_not_found" };
  }

  const points =
    reason.allow_points_override && input.points !== undefined ? input.points : reason.points;
  const expiryDays = input.expiryDays ?? reason.expiry_days;

  if (
    !Number.isInteger(points) ||
    points < 0 ||
    points > 1_000 ||
    !Number.isInteger(expiryDays) ||
    expiryDays < 0 ||
    expiryDays > 3_650
  ) {
    return { ok: false, code: "invalid_request" };
  }

  const memberNote = (input.memberNote ?? "").slice(0, 2_000);
  const staffNote = (input.staffNote ?? "").slice(0, 2_000);
  const expiresAt = new Date(Date.now() + Math.max(expiryDays, 1) * 86_400_000);

  return sql.begin(async (tx) => {
    const member = (await tx`
      SELECT id FROM core.members WHERE id = ${input.memberId} FOR UPDATE
    `) as unknown[];

    if (member.length === 0) {
      return { ok: false as const, code: "not_found" as const };
    }

    const before = await activeWarningPoints(tx, input.memberId);
    const rows = (await tx`
      INSERT INTO core.warnings (
        member_id, reason_id, points, expires_at, content_type, content_id,
        member_note, staff_note, ack_required, issued_by
      )
      VALUES (
        ${input.memberId}, ${input.reasonId}, ${points}, ${expiresAt},
        ${input.contentType ?? null}, ${input.contentId ?? null},
        ${memberNote}, ${staffNote}, ${input.ackRequired === true}, ${input.actorId}
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    const warningId = rows[0]?.id;

    if (warningId === undefined) {
      throw new Error("Could not insert the warning");
    }

    const after = before + points;
    const thresholds = (await tx`
      SELECT id::text AS id, points, action, duration_hours
      FROM core.warning_thresholds
      WHERE points > ${before} AND points <= ${after}
      ORDER BY points, id
    `) as Array<{
      id: string;
      points: number;
      action: WarningAction;
      duration_hours: number | null;
    }>;

    for (const threshold of thresholds) {
      const kind = actionRestriction(threshold.action);
      const until =
        threshold.duration_hours === null
          ? null
          : new Date(Date.now() + threshold.duration_hours * 3_600_000);
      await tx`
        INSERT INTO core.member_restrictions (member_id, kind, until, source_warning_id)
        VALUES (${input.memberId}, ${kind}, ${until}, ${warningId})
        ON CONFLICT (member_id, kind) DO UPDATE
        SET until = CASE
              WHEN EXCLUDED.until IS NULL THEN NULL
              WHEN core.member_restrictions.until IS NULL THEN NULL
              ELSE GREATEST(core.member_restrictions.until, EXCLUDED.until)
            END,
            source_warning_id = EXCLUDED.source_warning_id,
            created_at = now()
      `;
    }

    await emit(tx, {
      type: "warning.issued",
      aggregateId: BigInt(warningId),
      aggregateVersion: 1n,
      payloadIds: {
        warningId: BigInt(warningId),
        memberId: BigInt(input.memberId),
        actorId: BigInt(input.actorId),
      },
    });

    return { ok: true as const, result: { warningId, points: after } };
  });
}

export async function revokeWarning(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly warningId: string;
    readonly reason: string;
  },
): Promise<WarningOutcome<{ readonly revoked: boolean }>> {
  if (!/^\d+$/.test(input.warningId) || input.reason.trim() === "") {
    return { ok: false, code: "invalid_request" };
  }

  const [warning] = (await sql`
    SELECT member_id::text AS member_id, content_type, content_id::text AS content_id
    FROM core.warnings WHERE id = ${input.warningId}
  `) as Array<{
    member_id: string;
    content_type: "post" | "member" | null;
    content_id: string | null;
  }>;

  if (warning === undefined) {
    return { ok: false, code: "not_found" };
  }

  const tree = await loadForumTree(sql);
  const forumId =
    warning.content_type === "post" && warning.content_id !== null
      ? await contentForumId(sql, "post", warning.content_id)
      : null;
  const allowed =
    forumId === null
      ? await canWarnAnywhere(sql, input.actorId, tree)
      : await can(sql, input.actorId, "warn", { forumId, tree });

  if (!allowed) {
    return { ok: false, code: "forbidden" };
  }

  const rows = (await sql`
    UPDATE core.warnings
    SET revoked_at = now(), revoked_by = ${input.actorId}, revoke_reason = ${input.reason.slice(0, 1_000)}
    WHERE id = ${input.warningId} AND revoked_at IS NULL
    RETURNING id
  `) as unknown[];

  return { ok: true, result: { revoked: rows.length > 0 } };
}
