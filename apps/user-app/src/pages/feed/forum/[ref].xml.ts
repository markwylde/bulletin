import type { APIRoute } from "astro";
import { feedDocumentFor } from "../../../seo/feeds.ts";
import { readSql, seoRoute } from "../../../seo/route.ts";

/** `GET /feed/forum/<ref>.xml`: one guest-readable forum's RSS feed. */
export const GET: APIRoute = ({ request, params }) =>
  seoRoute(request, ({ origin }) =>
    feedDocumentFor({
      sql: readSql(),
      origin,
      format: "rss",
      forumRef: params.ref ?? null,
    }),
  );
