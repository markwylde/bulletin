import { loadThemeResources } from "@bulletin/domain/themes";
import type { APIRoute } from "astro";
import { readSql } from "../db.ts";
import { currentSessionContext } from "../session.ts";
import { loadActiveTheme, themeCss } from "../theme/render.ts";
import { resolveRequestTheme } from "../theme/request-theme.ts";

/** The active theme's tokens and custom CSS, layered over the bundled default stylesheet. */
export const GET: APIRoute = async ({ request }) => {
  const sql = readSql();
  const cookieHeader = request.headers.get("cookie");
  const session = await currentSessionContext(cookieHeader).catch(() => null);
  const requested = await resolveRequestTheme(sql, cookieHeader, session);
  const theme = await loadActiveTheme(sql, requested.themeId);
  const resources =
    theme === null
      ? { tokens: { light: {}, dark: {} }, css: "" }
      : await loadThemeResources(
          sql,
          theme.chain.map((entry) => entry.id),
        );
  const privateResponse = requested.preview || session !== null;

  return new Response(themeCss(resources), {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": privateResponse ? "private, no-store" : "public, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
};
