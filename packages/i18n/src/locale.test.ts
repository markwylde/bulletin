import { describe, expect, test } from "bun:test";
import {
  BP_COOKIE_MAX_AGE_SECONDS,
  bpCookieOptions,
  DEFAULT_BP_SCHEME,
  DEFAULT_BP_THEME_ID,
  localeFromAcceptLanguage,
  localeFromBp,
  localeFromBpCookie,
  parseBpCookie,
  resolveLocale,
  resolveRequestLocale,
  serializeBpCookie,
} from "./locale.ts";

describe("locale selection", () => {
  test("resolves only shipped locales and defaults to English", () => {
    expect(resolveLocale("es")).toBe("es");
    expect(resolveLocale("fr")).toBe("fr");
    expect(resolveLocale("de")).toBe("en");
    expect(resolveLocale(null)).toBe("en");
  });
});

describe("bp cookie codec", () => {
  test("parses locale, theme and scheme", () => {
    expect(parseBpCookie("es.2.dark")).toEqual({
      locale: "es",
      themeId: 2,
      scheme: "dark",
    });
  });

  test("a malformed cookie falls back to every default", () => {
    const defaults = {
      locale: "en",
      themeId: DEFAULT_BP_THEME_ID,
      scheme: DEFAULT_BP_SCHEME,
    } as const;

    expect(parseBpCookie("xx.9999999.neon")).toEqual(defaults);
    expect(parseBpCookie("fr.2.neon")).toEqual(defaults);
    expect(parseBpCookie("fr")).toEqual(defaults);
    expect(parseBpCookie(null)).toEqual(defaults);
  });

  test("serialises defaults and given preferences", () => {
    expect(serializeBpCookie()).toBe(`en.${DEFAULT_BP_THEME_ID}.${DEFAULT_BP_SCHEME}`);
    expect(serializeBpCookie({ locale: "fr", themeId: 2, scheme: "dark" })).toBe("fr.2.dark");
    expect(serializeBpCookie({ locale: "es", themeId: Number.NaN, scheme: "light" })).toBe(
      `es.${DEFAULT_BP_THEME_ID}.light`,
    );
  });

  test("exposes only the explicit cookie locale", () => {
    expect(localeFromBpCookie("es.2.dark")).toBe("es");
    expect(localeFromBpCookie("xx.2.dark")).toBeNull();
    expect(localeFromBpCookie("es.2.neon")).toBeNull();
    expect(localeFromBpCookie("es")).toBeNull();
    expect(localeFromBpCookie(null)).toBeNull();
    expect(localeFromBp("fr.1.light")).toBe("fr");
  });

  test("uses a host-only, non-HttpOnly, lax, one-year cookie", () => {
    expect(bpCookieOptions()).toEqual({
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      maxAge: BP_COOKIE_MAX_AGE_SECONDS,
      secure: false,
    });
    expect(BP_COOKIE_MAX_AGE_SECONDS).toBe(31_536_000);
    expect(bpCookieOptions({ secure: true }).secure).toBe(true);
  });
});

describe("Accept-Language suggestions", () => {
  test("matches the highest-quality shipped language", () => {
    expect(localeFromAcceptLanguage("de-DE,es;q=0.9,fr;q=0.8")).toBe("es");
    expect(localeFromAcceptLanguage("fr-CA,fr;q=0.9,en;q=0.1")).toBe("fr");
    expect(localeFromAcceptLanguage("es-MX")).toBe("es");
    expect(localeFromAcceptLanguage("de,ja")).toBeNull();
    expect(localeFromAcceptLanguage("")).toBeNull();
  });
});

describe("request locale resolution", () => {
  test("members use their preference", () => {
    expect(
      resolveRequestLocale({
        audience: "member",
        memberLocale: "fr",
        boardDefaultLocale: "es",
        acceptLanguage: "es",
      }),
    ).toEqual({ locale: "fr", source: "member", suggestion: null });
  });

  test("members without a valid preference use the board default", () => {
    expect(
      resolveRequestLocale({
        audience: "member",
        memberLocale: null,
        boardDefaultLocale: "es",
        acceptLanguage: "fr",
      }),
    ).toEqual({ locale: "es", source: "board", suggestion: "fr" });
  });

  test("members without a preference or board default use English", () => {
    expect(resolveRequestLocale({ audience: "member", boardDefaultLocale: "de" })).toEqual({
      locale: "en",
      source: "default",
      suggestion: null,
    });
  });

  test("guests use the bp cookie locale", () => {
    expect(
      resolveRequestLocale({
        audience: "guest",
        bp: "es.2.dark",
        boardDefaultLocale: "fr",
        acceptLanguage: "fr",
      }),
    ).toEqual({ locale: "es", source: "cookie", suggestion: null });
  });

  test("guests without a cookie use the board default", () => {
    expect(
      resolveRequestLocale({
        audience: "guest",
        bp: "xx.2.dark",
        boardDefaultLocale: "fr",
        acceptLanguage: "es",
      }),
    ).toEqual({ locale: "fr", source: "board", suggestion: "es" });
  });

  test("guests without a cookie or board default use English", () => {
    expect(
      resolveRequestLocale({
        audience: "guest",
        boardDefaultLocale: null,
        acceptLanguage: "fr",
      }),
    ).toEqual({ locale: "en", source: "default", suggestion: "fr" });
  });

  test("Accept-Language never changes the resolved locale", () => {
    const resolution = resolveRequestLocale({
      audience: "guest",
      boardDefaultLocale: "en",
      acceptLanguage: "es-ES,es;q=0.9",
    });

    expect(resolution.locale).toBe("en");
    expect(resolution.suggestion).toBe("es");
  });

  test("does not suggest the locale already in use", () => {
    expect(
      resolveRequestLocale({
        audience: "guest",
        boardDefaultLocale: "es",
        acceptLanguage: "es-MX,es;q=0.9",
      }).suggestion,
    ).toBeNull();
  });
});
