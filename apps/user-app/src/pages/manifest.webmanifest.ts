import { createServerT } from "@bulletin/i18n";
import type { APIRoute } from "astro";
import { readBoard } from "../board.ts";
import { USER_CATALOGS } from "../catalogs.ts";
import { readSql } from "../db.ts";
import { buildManifest, parseThemeReference } from "../pwa/manifest.ts";
import { resolvePwaTheme } from "../pwa/theme.ts";
import { boardNameFrom } from "../theme/render.ts";

/**
 * `GET /manifest.webmanifest`: the installable app manifest for the active theme (ADR 0014).
 * An optional `?theme=<id>@<version>` makes the response shareable and cacheable by theme;
 * without it the viewer's own theme and colour scheme decide the colours.
 */
export const GET: APIRoute = async ({ request, url }) => {
  const sql = readSql();
  const locale = "en";
  const translate = createServerT(locale, { shipped: USER_CATALOGS });
  const reference = parseThemeReference(url.searchParams.get("theme"));
  const [board, theme] = await Promise.all([
    readBoard(sql).catch(() => null),
    resolvePwaTheme(sql, request.headers.get("cookie"), reference),
  ]);
  const manifest = buildManifest({
    boardName: boardNameFrom(board?.boardName, translate),
    description: translate("pwa.manifest.description"),
    theme: theme.manifest,
  });

  return new Response(JSON.stringify(manifest), {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": theme.privateResponse
        ? "private, max-age=0, must-revalidate"
        : "public, max-age=0, must-revalidate",
      vary: "Cookie",
      "surrogate-key": `theme:${theme.manifest.id}`,
      "x-content-type-options": "nosniff",
    },
  });
};
