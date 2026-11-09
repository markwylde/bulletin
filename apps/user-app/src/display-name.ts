import type { Translator } from "@bulletin/i18n";

export interface DisplayNameCopy {
  readonly title: string;
  readonly label: string;
  readonly help: string;
  readonly save: string;
}

/** Copy for the display-name step page, which lands with the template stack. */
export function displayNameCopy(t: Translator): DisplayNameCopy {
  return {
    title: t("displayName.title"),
    label: t("displayName.label"),
    help: t("displayName.help"),
    save: t("displayName.save"),
  };
}

/** Maps the display-name API error codes to user-facing messages. */
export function displayNameError(
  t: Translator,
  code: string,
  options: { readonly nextAllowedAt?: string } = {},
): string {
  switch (code) {
    case "display_name_required":
      return t("displayName.required");
    case "display_name_taken":
      return t("displayName.taken");
    case "display_name_invalid":
      return t("displayName.invalid");
    case "display_name_change_limit":
      return t("displayName.changeLimit", { date: options.nextAllowedAt ?? "" });
    default:
      return t("auth.loginError");
  }
}
