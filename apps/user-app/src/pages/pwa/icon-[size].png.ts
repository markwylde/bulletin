import { createServerT } from "@bulletin/i18n";
import type { APIRoute } from "astro";
import sharp from "sharp";
import { readBoard } from "../../board.ts";
import { USER_CATALOGS } from "../../catalogs.ts";
import { readSql } from "../../db.ts";
import { iconLetter, iconSvg, parseThemeReference } from "../../pwa/manifest.ts";
import { resolvePwaTheme } from "../../pwa/theme.ts";
import { boardNameFrom } from "../../theme/render.ts";

const SIZES = new Set(["180", "192", "512"]);
const icons = new Map<string, Uint8Array>();

/**
 * `GET /pwa/icon-<size>.png?theme=<id>@<version>`: a raster icon in the active theme's colours.
 * The manifest needs 192 and 512 pixel icons for installation; 180 is the Apple touch icon.
 */
export const GET: APIRoute = async ({ params, request, url }) => {
  const size = Number(params.size ?? "");

  if (!SIZES.has(String(size))) {
    return new Response("Not found", { status: 404 });
  }

  const sql = readSql();
  const translate = createServerT("en", { shipped: USER_CATALOGS });
  const [board, theme] = await Promise.all([
    readBoard(sql).catch(() => null),
    resolvePwaTheme(
      sql,
      request.headers.get("cookie"),
      parseThemeReference(url.searchParams.get("theme")),
    ),
  ]);
  const boardName = boardNameFrom(board?.boardName, translate);
  const key = `${theme.manifest.id}@${theme.manifest.version}:${size}:${theme.manifest.tokens.bg}:${theme.manifest.tokens.accent}:${iconLetter(boardName)}`;
  let png = icons.get(key);

  if (png === undefined) {
    png = await sharp(
      Buffer.from(
        iconSvg({ size, tokens: theme.manifest.tokens, letter: iconLetter(boardName) }),
        "utf8",
      ),
    )
      .resize(size, size)
      .png()
      .toBuffer();

    if (icons.size > 64) {
      icons.clear();
    }

    icons.set(key, png);
  }

  return new Response(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      "cache-control": theme.privateResponse
        ? "private, max-age=3600"
        : "public, max-age=31536000, immutable",
      vary: "Cookie",
      "surrogate-key": `theme:${theme.manifest.id}`,
      "x-content-type-options": "nosniff",
    },
  });
};
