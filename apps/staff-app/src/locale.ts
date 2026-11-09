import { type Locale, localeFromBp, resolveLocale } from "@bulletin/i18n";

/** Locale from `?lang=` then the guest `bp` cookie; used by the placeholder SPA. */
export function localeFromRequest(search: string, cookieHeader: string): Locale {
  const query = new URLSearchParams(search).get("lang");
  const bp = /(?:^|;\s*)bp=([^;]+)/.exec(cookieHeader)?.[1] ?? null;

  return resolveLocale(query ?? localeFromBp(bp));
}
