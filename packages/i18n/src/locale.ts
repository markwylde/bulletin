import { DEFAULT_LOCALE, isLocale, type Locale } from "./catalog.ts";

export const BP_COOKIE_NAME = "bp";
export const BP_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const COLOR_SCHEMES = ["light", "dark", "system"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

export const DEFAULT_BP_THEME_ID = 1;
export const DEFAULT_BP_SCHEME: ColorScheme = "system";

/** The exact format the CDN proxy keys on (ADR 0006). */
const BP_COOKIE_VALUE = /^(en|es|fr)\.(\d{1,6})\.(light|dark|system)$/;

export interface BpPreferences {
  readonly locale: Locale;
  readonly themeId: number;
  readonly scheme: ColorScheme;
}

export type BpPreferenceInput = Partial<BpPreferences>;

export interface BpCookieOptions {
  readonly httpOnly: false;
  readonly sameSite: "lax";
  readonly path: "/";
  readonly maxAge: number;
  readonly secure: boolean;
}

/** Valid locale or the board default (English when no board setting is available). */
export function resolveLocale(value: string | null | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

function parseThemeId(value: string | undefined): number {
  if (value === undefined || !/^\d{1,6}$/.test(value)) {
    return DEFAULT_BP_THEME_ID;
  }

  const themeId = Number(value);
  return Number.isSafeInteger(themeId) ? themeId : DEFAULT_BP_THEME_ID;
}

function parseScheme(value: string | undefined): ColorScheme {
  return value !== undefined && (COLOR_SCHEMES as readonly string[]).includes(value)
    ? (value as ColorScheme)
    : DEFAULT_BP_SCHEME;
}

function matchBpCookie(value: string | null | undefined): BpPreferences | null {
  const match = BP_COOKIE_VALUE.exec(value ?? "");
  const locale = match?.[1];
  const themeId = match?.[2];
  const scheme = match?.[3];

  if (locale === undefined || themeId === undefined || scheme === undefined) {
    return null;
  }

  return {
    locale: locale as Locale,
    themeId: Number(themeId),
    scheme: scheme as ColorScheme,
  };
}

/**
 * Parses the `bp` cookie. A malformed cookie falls back to all defaults, matching the proxy
 * that strips it before the CDN cache key is computed (ADR 0006).
 */
export function parseBpCookie(value: string | null | undefined): BpPreferences {
  return (
    matchBpCookie(value) ?? {
      locale: DEFAULT_LOCALE,
      themeId: DEFAULT_BP_THEME_ID,
      scheme: DEFAULT_BP_SCHEME,
    }
  );
}

/** Serialises the `bp` cookie value as `<locale>.<themeId>.<scheme>`. */
export function serializeBpCookie(preferences: BpPreferenceInput = {}): string {
  const locale = isLocale(preferences.locale) ? preferences.locale : DEFAULT_LOCALE;
  const themeId = parseThemeId(
    preferences.themeId === undefined ? undefined : String(preferences.themeId),
  );
  const scheme = parseScheme(preferences.scheme);

  return `${locale}.${themeId}.${scheme}`;
}

export function bpCookieOptions(options: { readonly secure?: boolean } = {}): BpCookieOptions {
  return {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: BP_COOKIE_MAX_AGE_SECONDS,
    secure: options.secure ?? false,
  };
}

/** The locale explicitly stored in a well-formed cookie, or null otherwise. */
export function localeFromBpCookie(value: string | null | undefined): Locale | null {
  return matchBpCookie(value)?.locale ?? null;
}

/** Backwards-compatible helper for the placeholder pages. */
export function localeFromBp(value: string | null | undefined): Locale {
  return parseBpCookie(value).locale;
}

export type LocaleSource = "member" | "query" | "cookie" | "board" | "default";

export interface LocaleRequest {
  readonly audience: "member" | "guest";
  readonly memberLocale?: string | null;
  readonly bp?: string | null;
  /**
   * A guest's explicit `?lang=` (the URL `hreflang` alternates advertise). It is part of the
   * URL, so the CDN key and the origin variant key both separate it (ADR 0006, 0013).
   */
  readonly query?: string | null;
  readonly boardDefaultLocale?: string | null;
  readonly acceptLanguage?: string | null;
}

export interface LocaleResolution {
  readonly locale: Locale;
  readonly source: LocaleSource;
  /** A client-side switch suggestion; it never changes the server-rendered locale. */
  readonly suggestion: Locale | null;
}

/** First shipped locale in an `Accept-Language` header, respecting q-values. */
export function localeFromAcceptLanguage(value: string | null | undefined): Locale | null {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }

  const candidates = value
    .split(",")
    .map((part, index) => {
      const [tag = "", ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="));
      const parsed = quality === undefined ? 1 : Number(quality.slice(2));

      return {
        index,
        tag: tag.trim().toLowerCase(),
        quality: Number.isFinite(parsed) ? parsed : 0,
      };
    })
    .filter((candidate) => candidate.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  for (const candidate of candidates) {
    const base = candidate.tag.split("-")[0];

    if (base !== undefined && isLocale(base)) {
      return base;
    }
  }

  return null;
}

export function suggestLocale(
  acceptLanguage: string | null | undefined,
  current: Locale,
): Locale | null {
  const suggested = localeFromAcceptLanguage(acceptLanguage);
  return suggested === null || suggested === current ? null : suggested;
}

/**
 * Resolves a member's locale from their preference, or a guest's from an explicit `?lang=`,
 * then the `bp` cookie, then the board default. `Accept-Language` is only ever returned as a
 * client-side suggestion, so a cached guest page stays a function of its URL and `bp`.
 */
export function resolveRequestLocale(request: LocaleRequest): LocaleResolution {
  const board = isLocale(request.boardDefaultLocale) ? request.boardDefaultLocale : null;
  let locale: Locale;
  let source: LocaleSource;

  if (request.audience === "member" && isLocale(request.memberLocale)) {
    locale = request.memberLocale;
    source = "member";
  } else if (request.audience === "guest") {
    const cookie = localeFromBpCookie(request.bp);

    if (isLocale(request.query)) {
      locale = request.query;
      source = "query";
    } else if (cookie !== null) {
      locale = cookie;
      source = "cookie";
    } else if (board !== null) {
      locale = board;
      source = "board";
    } else {
      locale = DEFAULT_LOCALE;
      source = "default";
    }
  } else if (board !== null) {
    locale = board;
    source = "board";
  } else {
    locale = DEFAULT_LOCALE;
    source = "default";
  }

  const suggestion =
    source === "board" || source === "default"
      ? suggestLocale(request.acceptLanguage, locale)
      : null;

  return { locale, source, suggestion };
}
