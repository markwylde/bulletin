import type { Catalog, Locale } from "@bulletin/i18n";
import en from "../i18n/merged/en.json";
import es from "../i18n/merged/es.json";
import fr from "../i18n/merged/fr.json";

/** The generated app catalogs, already merged from app and package catalogs. */
export const STAFF_CATALOGS = { en, es, fr } as const satisfies Record<Locale, Catalog>;
