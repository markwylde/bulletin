import { parseCookieHeader } from "@bulletin/domain/auth";
import {
  appearanceOptions,
  guestThemeId,
  memberAppearance,
  previewThemeForSession,
} from "@bulletin/domain/themes";
import type { ColorScheme } from "@bulletin/i18n";
import { BP_COOKIE_NAME, DEFAULT_BP_THEME_ID, parseBpCookie } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { UserAppSessionContext } from "../session.ts";

export interface RequestTheme {
  /** The theme id the viewer asked for; null means the bundled default. */
  readonly themeId: string | null;
  readonly preview: boolean;
  /** A guest's `bp` named a theme that is missing or not available to Guests. */
  readonly invalidGuestTheme: boolean;
  readonly scheme: ColorScheme;
}

/**
 * Resolves the viewer's theme for one request (ADR 0006, 0008): a member's preview grant wins;
 * a guest's `bp` choice is validated against the theme's availability before it is used.
 */
export async function resolveRequestTheme(
  sql: SQL,
  cookieHeader: string | null,
  session: UserAppSessionContext | null,
): Promise<RequestTheme> {
  if (session !== null) {
    const [preview, appearance] = await Promise.all([
      previewThemeForSession(sql, session.sessionId, session.memberId),
      memberAppearance(sql, session.memberId),
    ]);

    return {
      themeId: preview ?? appearance.themeId,
      preview: preview !== null,
      invalidGuestTheme: false,
      scheme: appearance.scheme,
    };
  }

  const bp = parseBpCookie(parseCookieHeader(cookieHeader)[BP_COOKIE_NAME]);

  const guestDefault = (await appearanceOptions(sql, null)).themeId;

  if (bp.themeId === DEFAULT_BP_THEME_ID) {
    return {
      themeId: guestDefault,
      preview: false,
      invalidGuestTheme: false,
      scheme: bp.scheme,
    };
  }

  const allowed = await guestThemeId(sql, String(bp.themeId)).catch(() => null);

  return {
    themeId: allowed ?? guestDefault,
    preview: false,
    invalidGuestTheme: allowed === null,
    scheme: bp.scheme,
  };
}
