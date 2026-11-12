import { listModerationLog, type ModerationLogFilters } from "@bulletin/domain/moderation";
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

function idParameter(value: string | null): string | null {
  return value !== null && /^\d+$/.test(value) ? value : null;
}

function intParameter(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function dateParameter(value: string | null): Date | null {
  if (value === null || value === "" || Number.isNaN(Date.parse(value))) {
    return null;
  }

  return new Date(value);
}

export function moderationLogFilters(url: URL): ModerationLogFilters {
  const action = url.searchParams.get("action");
  const from = dateParameter(url.searchParams.get("from"));
  const to = dateParameter(url.searchParams.get("to"));

  return {
    actorId: idParameter(url.searchParams.get("actorId")),
    action: action !== null && /^[a-z][a-z0-9_.]*$/.test(action) ? action : null,
    forumId: idParameter(url.searchParams.get("forumId")),
    memberId: idParameter(url.searchParams.get("memberId")),
    from,
    to,
    limit: intParameter(url.searchParams.get("limit"), 50, 1, 200),
    offset: intParameter(url.searchParams.get("offset"), 0, 0, 100_000),
  };
}

export async function moderationLogResponse(
  sql: SQL,
  session: Session,
  request: Request,
): Promise<Response> {
  const page = await listModerationLog(sql, {
    actorId: session.memberId,
    sessionId: session.id ?? session.sessionId ?? null,
    filters: moderationLogFilters(new URL(request.url)),
  });

  return json({
    allowed: page.allowed,
    total: page.total,
    entries: page.entries.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
}
