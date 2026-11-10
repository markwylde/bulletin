import { isLocale, type Locale } from "@bulletin/i18n";
import { useId, useState } from "react";
import { writeGuestLocale } from "./locale.ts";

export interface LanguageOption {
  readonly value: Locale;
  readonly label: string;
}

export interface LanguageSwitcherProps {
  readonly current: string;
  readonly options: readonly LanguageOption[];
  readonly label: string;
  /** Shown when a member without a display name cannot save a preference yet. */
  readonly nameRequired: string;
  readonly saveFailed: string;
}

interface SessionView {
  readonly authenticated?: boolean;
  readonly csrfToken?: string | null;
}

async function readSession(): Promise<SessionView | null> {
  try {
    const response = await fetch("/api/auth/session", {
      headers: { accept: "application/json" },
    });
    return (await response.json()) as SessionView;
  } catch {
    return null;
  }
}

/**
 * The language switcher island (ADR 0013, task 4.4): members save their preference through
 * user-api; guests get the `bp` cookie. It reads the session only when used, so shared pages
 * never carry a CSRF token (ADR 0006).
 */
export function LanguageSwitcher({
  current,
  options,
  label,
  nameRequired,
  saveFailed,
}: LanguageSwitcherProps) {
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: string): Promise<void> {
    if (next === current || pending || !isLocale(next)) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const session = await readSession();

      if (session?.authenticated === true) {
        const response = await fetch("/api/me/locale", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bulletin-csrf": session.csrfToken ?? "",
          },
          body: JSON.stringify({ locale: next }),
        });

        if (response.ok) {
          window.location.reload();
          return;
        }

        setError(response.status === 409 ? nameRequired : saveFailed);
      } else {
        writeGuestLocale(next);
        window.location.reload();
      }
    } catch {
      setError(saveFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="bl-language" data-language-switcher>
      <label className="bl-language__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="bl-language__select"
        data-language-select
        value={current}
        disabled={pending}
        onChange={(event) => {
          void change(event.currentTarget.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error === null ? null : (
        <span className="bl-language__error" role="alert" data-language-error>
          {error}
        </span>
      )}
    </span>
  );
}
