import type { APIRoute } from "astro";
import { feedDocumentFor } from "../../../seo/feeds.ts";
import { feedsFlagRoute } from "../../../seo/guard.ts";
import { readSql, seoRoute } from "../../../seo/route.ts";

/** `GET /feed/forum/<ref>.atom`: one guest-readable forum's Atom feed. */
export const GET: APIRoute = ({ request, params }) =>
  feedsFlagRoute(readSql(), request, () =>
    seoRoute(request, ({ origin }) =>
      feedDocumentFor({
        sql: readSql(),
        origin,
        format: "atom",
        forumRef: params.ref ?? null,
      }),
    ),
  );
