import { loadReplaceWords } from "@bulletin/domain/filters";
import { createServerT } from "@bulletin/i18n";
import type { APIRoute } from "astro";
import { USER_CATALOGS } from "../../../catalogs.ts";
import { loadLiveConversationMessages } from "../../../conversations/live.ts";
import { readSql } from "../../../db.ts";
import { loadViewerFlags } from "../../../flags.ts";

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

/** `GET /conversations/<id>/messages?after=`: one rendered, authorised live batch. */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const session = locals.session ?? null;

  if (session === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  const sql = readSql();
  const flags = await loadViewerFlags(sql, session);

  if (flags.values.conversations !== true) {
    return json({ code: "not_found" }, 404);
  }

  const conversationId = params.ref ?? "";

  if (!/^[1-9]\d{0,18}$/.test(conversationId)) {
    return json({ code: "not_found" }, 404);
  }

  const after = new URL(request.url).searchParams.get("after") ?? "0";

  if (!/^\d+$/.test(after)) {
    return json({ code: "invalid_request" }, 400);
  }

  const locale = locals.locale ?? "en";
  const result = await loadLiveConversationMessages({
    sql,
    conversationId,
    memberId: session.memberId,
    after,
    locale,
    translate: createServerT(locale, { shipped: USER_CATALOGS }),
    attachmentsEnabled: flags.values.attachments === true,
    mentionsEnabled: flags.values.mentions === true,
    replaceWords: await loadReplaceWords(sql),
  });

  return result === null ? json({ code: "not_found" }, 404) : json(result, 200);
};
