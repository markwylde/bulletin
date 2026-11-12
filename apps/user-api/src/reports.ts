import {
  createReport,
  isReportReason,
  isReportStatus,
  isReportTargetType,
  listReports,
  type ReportAction,
  readReportDetail,
  updateReport,
} from "@bulletin/domain/reports";
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

function failure(code: string): Response {
  return json(
    { code },
    code === "forbidden"
      ? 403
      : code === "not_found"
        ? 404
        : code === "already_reported"
          ? 409
          : 400,
  );
}

function intParameter(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function sessionIdOf(session: Session): string | null {
  return session.id ?? session.sessionId ?? null;
}

export async function createReportResponse(
  sql: SQL,
  session: Session,
  request: Request,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (body === null) {
    return json({ code: "invalid_request" }, 400);
  }

  const targetId = typeof body.targetId === "string" ? body.targetId : "";
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";

  if (
    !isReportTargetType(body.targetType) ||
    !isReportReason(body.reason) ||
    !/^\d+$/.test(targetId) ||
    comment.length > 2_000
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  const result = await createReport(sql, {
    actorId: session.memberId,
    targetType: body.targetType,
    targetId,
    reason: body.reason,
    comment,
    sessionId: sessionIdOf(session),
  });

  return result.ok ? json({ ok: true, reportId: result.result.reportId }) : failure(result.code);
}

export async function reportsListResponse(
  sql: SQL,
  session: Session,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const page = await listReports(sql, {
    actorId: session.memberId,
    sessionId: sessionIdOf(session),
    ...(isReportStatus(status) ? { status } : {}),
    limit: intParameter(url.searchParams.get("limit"), 25, 1, 100),
    offset: intParameter(url.searchParams.get("offset"), 0, 0, 10_000),
  });

  return json({
    total: page.total,
    reports: page.reports.map((report) => ({
      ...report,
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
      reporters: report.reporters.map((reporter) => ({
        ...reporter,
        createdAt: reporter.createdAt.toISOString(),
      })),
      comments: report.comments.map((comment) => ({
        ...comment,
        createdAt: comment.createdAt.toISOString(),
      })),
    })),
  });
}

export async function reportDetailResponse(
  sql: SQL,
  session: Session,
  reportId: string,
): Promise<Response> {
  const result = await readReportDetail(sql, {
    actorId: session.memberId,
    reportId,
    sessionId: sessionIdOf(session),
  });

  if (!result.ok) {
    return failure(result.code);
  }

  return json({
    report: {
      ...result.result,
      createdAt: result.result.createdAt.toISOString(),
      updatedAt: result.result.updatedAt.toISOString(),
      reporters: result.result.reporters.map((reporter) => ({
        ...reporter,
        createdAt: reporter.createdAt.toISOString(),
      })),
      comments: result.result.comments.map((comment) => ({
        ...comment,
        createdAt: comment.createdAt.toISOString(),
      })),
      pmMessages:
        result.result.pmMessages === null
          ? null
          : result.result.pmMessages.map((message) => ({
              ...message,
              createdAt: message.createdAt.toISOString(),
            })),
    },
  });
}

export async function reportActionResponse(
  sql: SQL,
  session: Session,
  reportId: string,
  request: Request,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (body === null || typeof body.action !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  let action: ReportAction | null = null;

  if (body.action === "status" && isReportStatus(body.status)) {
    action = { kind: "status", status: body.status };
  } else if (body.action === "assign") {
    action = { kind: "assign", assign: body.assign === true };
  } else if (body.action === "comment" && typeof body.body === "string") {
    action = { kind: "comment", body: body.body.slice(0, 5_000) };
  }

  if (action === null) {
    return json({ code: "invalid_request" }, 400);
  }

  const result = await updateReport(sql, {
    actorId: session.memberId,
    reportId,
    action,
    sessionId: sessionIdOf(session),
  });

  if (!result.ok) {
    return failure(result.code);
  }

  return json({
    ok: true,
    status: result.result.status,
    assigneeId: result.result.assigneeId,
  });
}
