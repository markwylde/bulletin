import { IntlMessageFormat, type PrimitiveType } from "intl-messageformat";
import en from "../i18n/en.json";
import es from "../i18n/es.json";
import fr from "../i18n/fr.json";

export const LOCALES = ["en", "es", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export type Catalog = Readonly<Record<string, string>>;
export type MessageValues = Readonly<Record<string, PrimitiveType>>;

export const CATALOGS = { en, es, fr } as const satisfies Record<Locale, Catalog>;
export type MessageKey = keyof (typeof CATALOGS)["en"];

const shipped: Record<Locale, Catalog> = CATALOGS;
const compiled = new Map<string, IntlMessageFormat>();

export class CatalogError extends Error {
  readonly code: "invalid_catalog" | "catalog_not_found";

  constructor(code: CatalogError["code"], message: string) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
  }
}

export function isLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && (LOCALES as readonly string[]).includes(value);
}

/** Guest locale from `?lang=` or the first segment of the `bp` cookie; defaults to English. */
export function resolveLocale(value: string | null | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function localeFromBp(bp: string | null | undefined): Locale {
  if (bp === null || bp === undefined) {
    return DEFAULT_LOCALE;
  }

  return resolveLocale(bp.split(".")[0] ?? null);
}

function compile(locale: Locale, message: string): IntlMessageFormat {
  const cacheKey = `${locale}\u0000${message}`;
  const cached = compiled.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const formatter = new IntlMessageFormat(message, locale);
  compiled.set(cacheKey, formatter);

  return formatter;
}

/** Parses an ICU message, throwing if its syntax is invalid. */
export function assertValidMessage(locale: Locale, message: string): void {
  compile(locale, message);
}

/** Formats an ICU MessageFormat string, including plural, select and number/date arguments. */
export function formatMessage(locale: Locale, message: string, values: MessageValues = {}): string {
  const formatted = compile(locale, message).format(values);

  if (typeof formatted !== "string") {
    throw new TypeError("ICU messages with rich-text tags are not supported");
  }

  return formatted;
}

export function catalogMessage(
  locale: Locale,
  key: string,
  catalog: Catalog = shipped[locale],
): string | undefined {
  return catalog[key] ?? shipped[DEFAULT_LOCALE][key];
}

/**
 * Translates a shipped key. Missing translations fall back to English and, if the key is unknown,
 * the key itself is returned so a page never renders `undefined`.
 */
export function t(locale: Locale, key: MessageKey, values: MessageValues = {}): string {
  const message = catalogMessage(locale, key);

  if (message === undefined) {
    return key;
  }

  return formatMessage(locale, message, values);
}

export function formatDate(
  value: Date | number,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

export function formatNumber(
  value: number | bigint,
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale: Locale,
  options: Intl.RelativeTimeFormatOptions = { numeric: "auto" },
): string {
  return new Intl.RelativeTimeFormat(locale, options).format(value, unit);
}

/** Validates a catalog loaded from JSON, a plugin bundle or an admin override. */
export function parseCatalog(value: unknown, source = "catalog"): Catalog {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogError(
      "invalid_catalog",
      `${source} must be an object mapping message keys to strings`,
    );
  }

  const catalog: Record<string, string> = {};

  for (const [key, message] of Object.entries(value)) {
    if (key.trim().length === 0) {
      throw new CatalogError("invalid_catalog", `${source} contains an empty message key`);
    }

    if (typeof message !== "string") {
      throw new CatalogError("invalid_catalog", `${source} key "${key}" must be a string`);
    }

    catalog[key] = message;
  }

  return catalog;
}

export async function loadCatalog(path: string | URL): Promise<Catalog> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    throw new CatalogError("catalog_not_found", `Catalog not found: ${String(path)}`);
  }

  return parseCatalog(await file.json(), String(path));
}
