/**
 * Applies the viewer's locale to the server-rendered page on the client (ADR 0013): members
 * follow their saved locale, guests follow `?lang=` or the `bp` preference cookie. The catalog
 * travels in a hidden element, not a nonce'd inline script, so an ETag 304 can never pair a
 * cached body with a different CSP nonce (ADR 0006, 0018).
 */

interface LocaleWindow extends Window {
  __bulletinApplyLocale?: (locale: string) => void;
}

type Catalog = Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;

function readCatalog(): Catalog {
  const text = document.querySelector<HTMLElement>("[data-i18n-catalog]")?.textContent ?? "{}";

  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Catalog) : {};
  } catch {
    return {};
  }
}

const data = readCatalog();
const params = new URLSearchParams(window.location.search);
const bp = /(?:^|;\s*)bp=([^;]+)/.exec(document.cookie)?.[1]?.split(".")[0];
const root = document.documentElement;

const applyLocale = (locale: string): void => {
  root.lang = locale;

  for (const element of document.querySelectorAll("[data-i18n]")) {
    if (element.hasAttribute("data-board-configured")) {
      continue;
    }

    const key = element.getAttribute("data-i18n") ?? "";
    const value = data[locale]?.[key] ?? data.en?.[key];

    if (value !== undefined) {
      element.textContent = value;
    }
  }
};

const isMember = root.dataset.localeSource === "member";
const requested = isMember ? root.dataset.serverLocale : (params.get("lang") ?? bp);
const locale = requested !== undefined && ["en", "es", "fr"].includes(requested) ? requested : "en";

applyLocale(locale);
(window as unknown as LocaleWindow).__bulletinApplyLocale = applyLocale;
