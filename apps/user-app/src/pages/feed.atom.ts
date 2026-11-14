import type { APIRoute } from "astro";
import { feedDocumentFor } from "../seo/feeds.ts";
import { feedsFlagRoute } from "../seo/guard.ts";
import { readSql, seoRoute } from "../seo/route.ts";

/** `GET /feed.atom`: the board-wide Atom feed of recent public topics. */
export const GET: APIRoute = ({ request }) =>
  feedsFlagRoute(readSql(), request, () =>
    seoRoute(request, ({ origin }) => feedDocumentFor({ sql: readSql(), origin, format: "atom" })),
  );
