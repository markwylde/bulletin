import {
  BP_COOKIE_MAX_AGE_SECONDS,
  BP_COOKIE_NAME,
  type ColorScheme,
  DEFAULT_BP_THEME_ID,
  isLocale,
  parseBpCookie,
  serializeBpCookie,
} from "@bulletin/i18n";
import { useEffect, useState } from "react";
import { useFlag } from "../flags.tsx";

export interface ThemeChooserLabels {
  readonly theme: string;
  readonly scheme: string;
  readonly save: string;
  readonly failed: string;
  readonly system: string;
  readonly light: string;
  readonly dark: string;
}

export interface ThemeChooserProps {
  readonly labels: ThemeChooserLabels;
}

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

async function csrfToken(): Promise<string | null> {
  try {
    const response = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
    const body = (await response.json()) as { csrfToken?: string | null };

    return typeof body.csrfToken === "string" ? body.csrfToken : null;
  } catch {
    return null;
  }
}

/** The footer and account appearance chooser, gated by `theme_chooser` (ADR 0008, 0010). */
export function ThemeChooser({ labels }: ThemeChooserProps) {
  const enabled = useFlag("theme_chooser");
  const [options, setOptions] = useState<AppearanceOptions | null>(null);
  const [themeId, setThemeId] = useState("");
  const [scheme, setScheme] = useState<ColorScheme>("system");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    void fetch("/api/theme-options", { headers: { accept: "application/json" } })
      .then(async (response) =>
        response.ok ? ((await response.json()) as AppearanceOptions) : null,
      )
      .then((next) => {
        if (cancelled || next === null) {
          return;
        }

        setOptions(next);
        setThemeId(next.themeId ?? next.themes[0]?.id ?? "");
        setScheme(next.scheme);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (options === null || pending) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      if (options.member) {
        const token = await csrfToken();
        const response = await fetch("/api/me/appearance", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token === null ? {} : { "x-bulletin-csrf": token }),
          },
          body: JSON.stringify({ themeId: themeId === "" ? null : themeId, scheme }),
        });

        if (!response.ok) {
          throw new Error("save failed");
        }
      } else {
        writeGuestAppearance(themeId, scheme);
      }

      window.location.reload();
    } catch {
      setError(labels.failed);
      setPending(false);
    }
  };

  return (
    <form
      className="bl-appearance"
      data-appearance-chooser
      hidden={!enabled || options === null}
      onSubmit={(event) => void submit(event)}
    >
      <label className="bl-appearance__field">
        <span>{labels.theme}</span>
        <select
          className="bl-input"
          data-appearance-theme
          value={themeId}
          onChange={(event) => setThemeId(event.target.value)}
        >
          {(options?.themes ?? []).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <label className="bl-appearance__field">
        <span>{labels.scheme}</span>
        <select
          className="bl-input"
          data-appearance-scheme
          value={scheme}
          onChange={(event) => setScheme(schemeOf(event.target.value))}
        >
          <option value="system">{labels.system}</option>
          <option value="light">{labels.light}</option>
          <option value="dark">{labels.dark}</option>
        </select>
      </label>
      <button
        className="bl-button bl-button--small"
        type="submit"
        data-appearance-save
        disabled={pending}
      >
        {labels.save}
      </button>
      {error === null ? null : (
        <p className="bl-error-text" data-appearance-error>
          {error}
        </p>
      )}
    </form>
  );
}
