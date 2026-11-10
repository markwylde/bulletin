import { useEffect, useState } from "react";
import type { LanguageOption } from "./LanguageSwitcher.tsx";
import { writeGuestLocale } from "./locale.ts";

export interface LocaleSuggestionProps {
  readonly current: string;
  readonly options: readonly LanguageOption[];
  readonly message: string;
  readonly accept: string;
  readonly dismiss: string;
}

function preferredLocale(
  options: readonly LanguageOption[],
  current: string,
): LanguageOption | null {
  const languages = navigator.languages.length > 0 ? navigator.languages : [navigator.language];

  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    const match = options.find((option) => option.value === base);

    if (match !== undefined && match.value !== current) {
      return match;
    }
  }

  return null;
}

/**
 * The client-side locale suggestion banner (ADR 0006, task 4.4). It never differs in the
 * server HTML: the server renders nothing and the browser decides from its own preferences,
 * so `Accept-Language` cannot split the guest cache.
 */
export function LocaleSuggestion({
  current,
  options,
  message,
  accept,
  dismiss,
}: LocaleSuggestionProps) {
  const [candidate, setCandidate] = useState<LanguageOption | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Members choose their language in the account settings (ADR 0013).
    if (document.documentElement.dataset.visitor === "member") {
      setCandidate(null);
      return;
    }

    setCandidate(preferredLocale(options, current));
  }, [current, options]);

  if (candidate === null || dismissed) {
    return null;
  }

  return (
    <div className="bl-locale-suggestion" role="status" data-locale-suggestion>
      <span>{message}</span> <strong>{candidate.label}</strong>
      <button
        type="button"
        className="bl-button bl-button--small"
        data-locale-suggestion-accept
        onClick={() => {
          writeGuestLocale(candidate.value);
          window.location.reload();
        }}
      >
        {accept}
      </button>
      <button
        type="button"
        className="bl-button bl-button--quiet bl-button--small"
        data-locale-suggestion-dismiss
        onClick={() => {
          setDismissed(true);
        }}
      >
        {dismiss}
      </button>
    </div>
  );
}
