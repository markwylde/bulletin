import {
  BP_COOKIE_MAX_AGE_SECONDS,
  BP_COOKIE_NAME,
  type ColorScheme,
  DEFAULT_BP_THEME_ID,
  isLocale,
  parseBpCookie,
  serializeBpCookie,
} from "@bulletin/i18n";
import { clientCsrfToken } from "../csrf.ts";

interface ThemeOption {
  readonly id: string;
  readonly name: string;
}

interface AppearanceOptions {
  readonly member: boolean;
  readonly themes: readonly ThemeOption[];
  readonly themeId: string | null;
  readonly scheme: ColorScheme;
}

function schemeOf(value: string | undefined): ColorScheme {
  return value === "light" || value === "dark" ? value : "system";
}

/** The guest preference cookie keeps the current locale while changing theme and scheme. */
function writeGuestAppearance(themeId: string, scheme: ColorScheme): void {
  const match = /(?:^|;\s*)bp=([^;]+)/.exec(document.cookie);
  const current = parseBpCookie(match?.[1]);
  const locale = isLocale(document.documentElement.lang)
    ? document.documentElement.lang
    : current.locale;
  const value = serializeBpCookie({
    locale,
    themeId: Number(themeId) || DEFAULT_BP_THEME_ID,
    scheme,
  });

  document.cookie = `${BP_COOKIE_NAME}=${value}; Path=/; Max-Age=${BP_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

function fill(form: HTMLFormElement, options: AppearanceOptions): void {
  const theme = form.querySelector<HTMLSelectElement>("[data-appearance-theme]");
  const scheme = form.querySelector<HTMLSelectElement>("[data-appearance-scheme]");

  if (theme === null || scheme === null) {
    return;
  }

  theme.replaceChildren(
    ...options.themes.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.name;
      return option;
    }),
  );

  if (options.themeId !== null && options.themes.some((entry) => entry.id === options.themeId)) {
    theme.value = options.themeId;
  }

  scheme.value = options.scheme;
  form.hidden = false;
}

async function save(form: HTMLFormElement, options: AppearanceOptions): Promise<void> {
  const theme = form.querySelector<HTMLSelectElement>("[data-appearance-theme]")?.value ?? "";
  const scheme = schemeOf(form.querySelector<HTMLSelectElement>("[data-appearance-scheme]")?.value);
  const error = form.querySelector<HTMLElement>("[data-appearance-error]");
  const button = form.querySelector<HTMLButtonElement>("[data-appearance-save]");

  if (error !== null) {
    error.hidden = true;
  }

  if (button !== null) {
    button.disabled = true;
  }

  try {
    if (options.member) {
      const token = await clientCsrfToken();
      const response = await fetch("/api/me/appearance", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === null ? {} : { "x-bulletin-csrf": token }),
        },
        body: JSON.stringify({ themeId: theme === "" ? null : theme, scheme }),
      });

      if (!response.ok) {
        throw new Error("save failed");
      }
    } else {
      writeGuestAppearance(theme, scheme);
    }

    window.location.reload();
  } catch {
    if (error !== null) {
      error.textContent = form.getAttribute("data-save-failed") ?? "";
      error.hidden = false;
    }

    if (button !== null) {
      button.disabled = false;
    }
  }
}

/** Fills the footer and account appearance forms from the viewer's allowed themes. */
export function initAppearanceChooser(): void {
  const forms = document.querySelectorAll<HTMLFormElement>("[data-appearance-chooser]");

  if (forms.length === 0) {
    return;
  }

  void fetch("/api/theme-options", { headers: { accept: "application/json" } })
    .then(async (response) => (response.ok ? ((await response.json()) as AppearanceOptions) : null))
    .then((options) => {
      if (options === null) {
        return;
      }

      for (const form of forms) {
        fill(form, options);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          void save(form, options);
        });
      }
    })
    .catch(() => undefined);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAppearanceChooser, { once: true });
} else {
  initAppearanceChooser();
}
