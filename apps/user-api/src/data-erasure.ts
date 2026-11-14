import type { AuthNodeEnv } from "@bulletin/domain/auth";
import { requestDataErasure } from "@bulletin/domain/privacy";
import type { SQL } from "bun";
import { userSessionToken } from "./push.ts";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** `POST /api/me/data-erasure`: request erasure and return the retained-record notice. */
export async function requestDataErasureResponse(
  sql: SQL,
  memberId: string,
  request: Request,
  nodeEnv: AuthNodeEnv,
): Promise<Response> {
  const token = userSessionToken(request, nodeEnv);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  const result = await requestDataErasure(sql, token, memberId);

  return result === null
    ? json({ code: "invalid_request" }, 400)
    : json({ requestId: result.requestId, retained: result.retained }, 202);
}
