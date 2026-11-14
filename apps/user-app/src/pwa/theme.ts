import { loadThemeResources } from "@bulletin/domain/themes";
import type { ColorScheme } from "@bulletin/i18n";
import type { SQL } from "bun";
import { currentSessionContext } from "../session.ts";
import { loadActiveTheme } from "../theme/render.ts";
import { resolveRequestTheme } from "../theme/request-theme.ts";
import {
  type ManifestTheme,
  type ManifestTokens,
  manifestTokens,
  type ThemeReference,
} from "./manifest.ts";

export interface PwaTheme {
  readonly manifest: ManifestTheme;
  readonly scheme: ColorScheme;
  /** A member session or staff preview theme must never be shared by the HTTP cache. */
  readonly privateResponse: boolean;
}

async function tokensFor(
  sql: SQL,
  themeId: string | null | undefined,
  scheme: ColorScheme,
): Promise<{
  readonly theme: Awaited<ReturnType<typeof loadActiveTheme>>;
  readonly tokens: ManifestTokens;
}> {
  const theme = await loadActiveTheme(sql, themeId);
  const resources =
    theme === null
      ? { tokens: { light: {}, dark: {} } }
      : await loadThemeResources(
          sql,
          theme.chain.map((entry) => entry.id),
        );

  return {
    theme,
    tokens: manifestTokens(resources.tokens[scheme === "dark" ? "dark" : "light"]),
  };
}

/**
 * Resolves the theme a manifest or icon belongs to (ADR 0006, 0014). An explicit
 * `theme=<id>@<version>` from the URL wins so the URL can be cached by theme; otherwise the
 * viewer's normal theme resolution applies.
 */
export async function resolvePwaTheme(
  sql: SQL,
  cookieHeader: string | null,
  reference: ThemeReference | null,
): Promise<PwaTheme> {
  const session = await currentSessionContext(cookieHeader).catch(() => null);

  if (reference !== null) {
    // A versioned URL is how the manifest and icons stay cacheable across theme edits.
    const { theme, tokens } = await tokensFor(sql, reference.id, "light");
    const id = theme?.theme.id ?? reference.id;
    const version = theme?.theme.version ?? reference.version ?? 0;

    return {
      manifest: { id, version, tokens },
      scheme: "light",
      privateResponse: session !== null,
    };
  }

  const requested = await resolveRequestTheme(sql, cookieHeader, session);
  const { theme, tokens } = await tokensFor(sql, requested.themeId, requested.scheme);
  const id = theme?.theme.id ?? "0";
  const version = theme?.theme.version ?? 0;

  return {
    manifest: { id, version, tokens },
    scheme: requested.scheme,
    privateResponse: session !== null || requested.preview,
  };
}
