import type { APIRoute } from "astro";
import { attachmentDownloadResponse } from "../../attachments/download.ts";
import { readSql } from "../../db.ts";
import { requestHasSession } from "../../http/cache.ts";
import { storage } from "../../storage.ts";

const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development";

/** `GET /attachments/<id>[/<filename>]` (task 3.1). */
export const GET: APIRoute = ({ params, locals, request }) => {
  const id = (params.ref ?? "").split("/")[0] ?? "";
  const session = locals.session ?? null;

  return attachmentDownloadResponse({
    sql: readSql(),
    storage,
    session: session === null ? null : { memberId: session.memberId, sessionId: session.sessionId },
    hasSessionCookie: requestHasSession(request.headers.get("cookie"), nodeEnv),
    id,
  });
};
