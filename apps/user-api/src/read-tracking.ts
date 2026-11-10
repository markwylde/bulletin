import { markBoardRead, markForumRead } from "@bulletin/domain/topics";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** `POST /api/forums/<id>/read`: one row; descendants inherit it (task 5.1). */
export async function markForumReadResponse(
  sql: SQL,
  memberId: string,
  forumId: string,
): Promise<Response> {
  const marked = await markForumRead(sql, memberId, forumId);

  return marked ? json({ ok: true }) : json({ code: "not_found" }, 404);
}

/** `POST /api/me/read-all`: one member row covers the whole board (task 5.1). */
export async function markBoardReadResponse(sql: SQL, memberId: string): Promise<Response> {
  await markBoardRead(sql, memberId);
  return json({ ok: true });
}
