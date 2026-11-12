import { resolveMemberLocale } from "@bulletin/domain/member";
import {
  acknowledgeWarnings,
  activeWarningPoints,
  canViewWarningHistory,
  hasUnacknowledgedWarning,
  issueWarning,
  listMemberRestrictions,
  listMemberWarnings,
  listStaffWarnings,
  listWarningReasons,
  revokeWarning,
} from "@bulletin/domain/warnings";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

interface Session {
  readonly memberId: string;
  readonly id?: string;
  readonly sessionId?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function bodyRecord(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);

  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function failure(code: string): Response {
  return json(
    { code },
    code === "forbidden"
      ? 403
      : code === "not_found" || code === "reason_not_found"
        ? 404
        : code === "duplicate_reason"
          ? 409
          : 400,
  );
}

function warningJson(warning: Awaited<ReturnType<typeof listMemberWarnings>>[number]) {
  return {
    ...warning,
    expiresAt: warning.expiresAt.toISOString(),
    expiredAt: warning.expiredAt?.toISOString() ?? null,
    revokedAt: warning.revokedAt?.toISOString() ?? null,
    ackedAt: warning.ackedAt?.toISOString() ?? null,
    createdAt: warning.createdAt.toISOString(),
  };
}

export async function ownWarningsResponse(sql: SQL, session: Session): Promise<Response> {
  const locale = await resolveMemberLocale(sql, session.memberId);
  const [warnings, points, restrictions, pendingAck] = await Promise.all([
    listMemberWarnings(sql, session.memberId, locale),
    activeWarningPoints(sql, session.memberId),
    listMemberRestrictions(sql, session.memberId),
    hasUnacknowledgedWarning(sql, session.memberId),
  ]);

  return json({
    points,
    pendingAck,
    restrictions: restrictions.map((restriction) => ({
      kind: restriction.kind,
      until: restriction.until?.toISOString() ?? null,
    })),
    warnings: warnings.map(warningJson),
  });
}

export async function acknowledgeWarningsResponse(sql: SQL, session: Session): Promise<Response> {
  return json({ ok: true, acknowledged: await acknowledgeWarnings(sql, session.memberId) });
}

export async function warningReasonsResponse(sql: SQL): Promise<Response> {
  return json({ reasons: await listWarningReasons(sql, { enabledOnly: true }) });
}

export async function memberWarningHistoryResponse(
  sql: SQL,
  session: Session,
  memberId: string,
  request: Request,
): Promise<Response> {
  if (!/^\d+$/.test(memberId)) {
    return json({ code: "not_found" }, 404);
  }

  if (!(await canViewWarningHistory(sql, session.memberId))) {
    return json({ code: "forbidden" }, 403);
  }

  const url = new URL(request.url);
  const locale = url.searchParams.get("locale") ?? "en";
  const [warnings, points, restrictions] = await Promise.all([
    listStaffWarnings(sql, memberId, locale),
    activeWarningPoints(sql, memberId),
    listMemberRestrictions(sql, memberId),
  ]);

  return json({
    memberId,
    points,
    restrictions: restrictions.map((restriction) => ({
      kind: restriction.kind,
      until: restriction.until?.toISOString() ?? null,
    })),
    warnings: warnings.map(warningJson),
  });
}

export async function issueWarningResponse(
  sql: SQL,
  session: Session,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null || typeof body.memberId !== "string" || typeof body.reasonId !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  const result = await issueWarning(sql, {
    actorId: session.memberId,
    memberId: body.memberId,
    reasonId: body.reasonId,
    ...(typeof body.points === "number" ? { points: body.points } : {}),
    ...(typeof body.expiryDays === "number" ? { expiryDays: body.expiryDays } : {}),
    ...(body.contentType === "post" || body.contentType === "member"
      ? { contentType: body.contentType }
      : {}),
    ...(typeof body.contentId === "string" ? { contentId: body.contentId } : {}),
    ...(typeof body.memberNote === "string" ? { memberNote: body.memberNote } : {}),
    ...(typeof body.staffNote === "string" ? { staffNote: body.staffNote } : {}),
    ...(typeof body.ackRequired === "boolean" ? { ackRequired: body.ackRequired } : {}),
  });

  return result.ok ? json({ ok: true, ...result.result }) : failure(result.code);
}

export async function revokeWarningResponse(
  sql: SQL,
  session: Session,
  warningId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null || typeof body.reason !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  const result = await revokeWarning(sql, {
    actorId: session.memberId,
    warningId,
    reason: body.reason,
  });

  return result.ok ? json({ ok: true, ...result.result }) : failure(result.code);
}
