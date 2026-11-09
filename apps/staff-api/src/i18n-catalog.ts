import type { Catalog, Locale } from "@bulletin/i18n";
import staffEn from "../../staff-app/i18n/merged/en.json";
import staffEs from "../../staff-app/i18n/merged/es.json";
import staffFr from "../../staff-app/i18n/merged/fr.json";
import userEn from "../../user-app/i18n/merged/en.json";
import userEs from "../../user-app/i18n/merged/es.json";
import userFr from "../../user-app/i18n/merged/fr.json";

function mergeCatalogs(...catalogs: readonly Catalog[]): Catalog {
  return Object.assign({}, ...catalogs);
}

/**
 * Every shipped string an administrator can override. The two merged app catalogs already
 * contain the package catalogs; duplicate keys share the same English base.
 */
export const EDITOR_CATALOGS = {
  en: mergeCatalogs(userEn, staffEn),
  es: mergeCatalogs(userEs, staffEs),
  fr: mergeCatalogs(userFr, staffFr),
} as const satisfies Record<Locale, Catalog>;

export const EDITOR_BASE: Catalog = EDITOR_CATALOGS.en;
