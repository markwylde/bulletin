import { CATALOGS, type Catalog, type Locale } from "@bulletin/i18n";
import en from "../i18n/en.json";
import es from "../i18n/es.json";
import fr from "../i18n/fr.json";

const appCatalogs = { en, es, fr } as const satisfies Record<Locale, Catalog>;

/** The app strings layered over the shared package catalogs. */
export const USER_CATALOGS = {
  en: { ...CATALOGS.en, ...appCatalogs.en },
  es: { ...CATALOGS.es, ...appCatalogs.es },
  fr: { ...CATALOGS.fr, ...appCatalogs.fr },
} as const satisfies Record<Locale, Catalog>;
