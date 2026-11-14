import type { APIRoute } from "astro";
import { readSql, seoRoute } from "../seo/route.ts";
import { sitemapIndexDocument } from "../seo/sitemaps.ts";

/** `GET /sitemap.xml`: the index of every public sitemap file (change `seo-feeds`). */
export const GET: APIRoute = ({ request }) =>
  seoRoute(request, ({ origin }) => sitemapIndexDocument({ sql: readSql(), origin }));
