export const LOCALES = ["en", "es", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

export const CATALOGS = {
  en: {
    "user.placeholder.title": "Bulletin",
    "user.placeholder.body": "The Bulletin community is being prepared.",
    "staff.placeholder.title": "Bulletin staff",
    "staff.placeholder.body": "The staff console is being prepared.",
  },
  es: {
    "user.placeholder.title": "Bulletin",
    "user.placeholder.body": "La comunidad de Bulletin se está preparando.",
    "staff.placeholder.title": "Personal de Bulletin",
    "staff.placeholder.body": "La consola del personal se está preparando.",
  },
  fr: {
    "user.placeholder.title": "Bulletin",
    "user.placeholder.body": "La communauté Bulletin est en préparation.",
    "staff.placeholder.title": "Équipe Bulletin",
    "staff.placeholder.body": "La console de l'équipe est en préparation.",
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type MessageKey = keyof (typeof CATALOGS)["en"];

export function isLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && (LOCALES as readonly string[]).includes(value);
}

/** Guest locale from `?lang=` or the first segment of the `bp` cookie; defaults to English. */
export function resolveLocale(value: string | null | undefined): Locale {
  return isLocale(value) ? value : "en";
}

export function localeFromBp(bp: string | null | undefined): Locale {
  if (bp === null || bp === undefined) {
    return "en";
  }

  return resolveLocale(bp.split(".")[0] ?? null);
}

/** Minimal lookup used only by the foundation placeholder pages. */
export function t(locale: Locale, key: MessageKey): string {
  return CATALOGS[locale][key] ?? CATALOGS.en[key];
}
