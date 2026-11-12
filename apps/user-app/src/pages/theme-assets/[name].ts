import { loadThemeResources } from "@bulletin/domain/themes";
import type { APIRoute } from "astro";
import { readSql } from "../../db.ts";
import { currentSessionContext } from "../../session.ts";
import { storage } from "../../storage.ts";
import { loadActiveTheme } from "../../theme/render.ts";
import { resolveRequestTheme } from "../../theme/request-theme.ts";

/** `GET /theme-assets/<name>`: one active theme asset, inherited from its parent if needed. */
export const GET: APIRoute = async ({ params, request }) => {
  const name = params.name ?? "";

  if (!/^[a-z0-9][a-z0-9._-]{0,100}$/.test(name)) {
    return new Response("Not found", { status: 404 });
  }

  const sql = readSql();
  const cookieHeader = request.headers.get("cookie");
  const session = await currentSessionContext(cookieHeader).catch(() => null);
  const requested = await resolveRequestTheme(sql, cookieHeader, session);
  const theme = await loadActiveTheme(sql, requested.themeId);

  if (theme === null) {
    return new Response("Not found", { status: 404 });
  }

  const resources = await loadThemeResources(
    sql,
    theme.chain.map((entry) => entry.id),
  );
  const asset = resources.assets.find((entry) => entry.name === name);

  if (asset === undefined) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const bytes = await storage.get(asset.storageKey);

    return new Response(new Uint8Array(bytes).buffer, {
      headers: {
        "content-type": asset.contentType,
        "cache-control":
          requested.preview || session !== null ? "private, max-age=60" : "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
};
