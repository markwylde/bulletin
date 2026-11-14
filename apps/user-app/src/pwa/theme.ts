import { can, GUEST_PRINCIPAL } from "@bulletin/domain/permissions";
import { loadThemeResources, previewThemeForSession } from "@bulletin/domain/themes";
import type { ColorScheme } from "@bulletin/i18n";
import type { SQL } from "bun";
import { readSessionContext, type UserAppSessionContext } from "../session.ts";
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

async function themeAllowed(
  sql: SQL,
  session: UserAppSessionContext | null,
  themeId: string,
): Promise<boolean> {
  if (session === null) {
    return can(sql, GUEST_PRINCIPAL, "use_theme", { themeId });
  }

  if ((await previewThemeForSession(sql, session.sessionId, session.memberId)) === themeId) {
    return true;
  }

  return can(sql, session.memberId, "use_theme", { themeId });
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
  const session = await readSessionContext(sql, cookieHeader).catch(() => null);
  const explicit =
    reference !== null && (await themeAllowed(sql, session, reference.id).catch(() => false))
      ? reference
      : null;

  if (explicit !== null) {
    // A versioned URL is how the manifest and icons stay cacheable across theme edits.
    const { theme, tokens } = await tokensFor(sql, explicit.id, "light");
    const id = theme?.theme.id ?? explicit.id;
    const version = theme?.theme.version ?? explicit.version ?? 0;

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
