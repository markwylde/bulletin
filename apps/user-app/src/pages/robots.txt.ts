import { GLOBAL_CACHE_TAGS } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import type { APIRoute } from "astro";
import { readSql } from "../db.ts";

/**
 * The generated default keeps crawlers out of viewer-specific and thin pages. Admins can
 * replace the whole file in the staff board settings; an empty value means this default.
 */
function defaultRobots(origin: string): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /search",
    "Disallow: /members",
    "Disallow: /account",
    "Disallow: /moderation",
    "Disallow: /conversations",
    "Disallow: /display-name",
    "Disallow: /auth",
    "Disallow: /offline",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

/** `GET /robots.txt`: the admin-managed file, or the generated default. */
export const GET: APIRoute = async ({ request }) => {
  const settings = await readBoardSettings(readSql());
  const body =
    settings.robotsTxt.trim() === ""
      ? defaultRobots(new URL(request.url).origin)
      : settings.robotsTxt;

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
      "surrogate-key": GLOBAL_CACHE_TAGS.board,
      "x-content-type-options": "nosniff",
    },
  });
};
