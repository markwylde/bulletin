import type { APIRoute } from "astro";
import { parseSitemapPage, readSql, seoRoute } from "../../../seo/route.ts";
import { sitemapPageDocument } from "../../../seo/sitemaps.ts";

/** `GET /sitemap/members/<page>.xml`: public member profiles. */
export const GET: APIRoute = ({ request, params }) => {
  const page = parseSitemapPage(params.page);

  if (page === null) {
    return new Response("", { status: 404, headers: { "cache-control": "no-store" } });
  }

  return seoRoute(request, ({ origin }) =>
    sitemapPageDocument({ sql: readSql(), origin, kind: "members", page }),
  );
};
