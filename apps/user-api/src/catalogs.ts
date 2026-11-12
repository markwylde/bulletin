import { type Catalog, createServerT, type Locale } from "@bulletin/i18n";
import en from "../i18n/merged/en.json";
import es from "../i18n/merged/es.json";
import fr from "../i18n/merged/fr.json";

/** Package catalogs (content quote labels); the API ships no app-specific UI strings. */
export const API_CATALOGS = { en, es, fr } as const satisfies Record<Locale, Catalog>;

export function apiTranslator(locale: Locale) {
  return createServerT(locale, { shipped: API_CATALOGS });
}
