import { clientIp } from "@bulletin/domain/auth";
import { requireFlag } from "@bulletin/flags";
import type { APIRoute } from "astro";
import { attachmentDownloadResponse } from "../../attachments/download.ts";
import { readSql } from "../../db.ts";
import { createUserFlags, loadFlagViewer } from "../../flags.ts";
import { requestHasSession } from "../../http/cache.ts";
import { storage } from "../../storage.ts";

const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development";

function guestViewerKey(request: Request): string | undefined {
  const secret = process.env.SESSION_SECRET;

  if (secret === undefined || secret === "") {
    return undefined;
  }

  return new Bun.CryptoHasher("sha256", secret)
    .update(`attachment-download:${clientIp(request) ?? "unknown"}`)
    .digest("hex");
}

/** `GET /attachments/<id>[/<filename>]` (task 3.1). */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const sql = readSql();
  const session = locals.session ?? null;
  const guard = requireFlag("attachments", {
    runtime: createUserFlags(sql),
    viewer: () => loadFlagViewer(sql, session),
  });

  return guard(request, () => {
    const id = (params.ref ?? "").split("/")[0] ?? "";
    const preview = new URL(request.url).searchParams.get("preview") === "1";
    const viewerKey = guestViewerKey(request);

    return attachmentDownloadResponse({
      sql,
      storage,
      session:
        session === null ? null : { memberId: session.memberId, sessionId: session.sessionId },
      hasSessionCookie: requestHasSession(request.headers.get("cookie"), nodeEnv),
      id,
      preview,
      ...(viewerKey === undefined ? {} : { guestViewerKey: viewerKey }),
    });
  });
};
