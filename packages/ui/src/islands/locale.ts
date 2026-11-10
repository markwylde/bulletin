import {
  BP_COOKIE_MAX_AGE_SECONDS,
  BP_COOKIE_NAME,
  type ColorScheme,
  type Locale,
  parseBpCookie,
  serializeBpCookie,
} from "@bulletin/i18n";

function bpCookieValue(): string | null {
  const match = /(?:^|;\s*)bp=([^;]+)/.exec(document.cookie);
  return match?.[1] ?? null;
}

/**
 * Sets the guest preference cookie (ADR 0006): `<locale>.<themeId>.<scheme>`, keeping the
 * theme and scheme the guest already chose.
 */
export function writeGuestLocale(locale: Locale, scheme?: ColorScheme): void {
  const current = parseBpCookie(bpCookieValue());
  const value = serializeBpCookie({
    locale,
    themeId: current.themeId,
    scheme: scheme ?? current.scheme,
  });

  document.cookie = `${BP_COOKIE_NAME}=${value}; Path=/; Max-Age=${BP_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}
