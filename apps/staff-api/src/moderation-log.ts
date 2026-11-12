import type { SessionRecord } from "@bulletin/domain/auth";
import { listModerationLog } from "@bulletin/domain/moderation";
import type { SQL } from "bun";

function json(body: unknown): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

function id(value: string | null): string | null {
  return value !== null && /^\d+$/.test(value) ? value : null;
}

function numberValue(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function date(value: string | null): Date | null {
  return value === null || Number.isNaN(Date.parse(value)) ? null : new Date(value);
}

export async function staffModerationLogResponse(
  sql: SQL,
  session: SessionRecord,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const page = await listModerationLog(sql, {
    actorId: session.memberId,
    sessionId: session.id,
    filters: {
      actorId: id(url.searchParams.get("actorId")),
      action: action !== null && /^[a-z][a-z0-9_.]*$/.test(action) ? action : null,
      forumId: id(url.searchParams.get("forumId")),
      memberId: id(url.searchParams.get("memberId")),
      from: date(url.searchParams.get("from")),
      to: date(url.searchParams.get("to")),
      limit: numberValue(url.searchParams.get("limit"), 50),
      offset: numberValue(url.searchParams.get("offset"), 0),
    },
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
