import type { Locale, Translator } from "@bulletin/i18n";
import type { BreadcrumbItem } from "../theme/render.ts";

export interface DisplayNamePageInput {
  readonly returnTo: string;
  readonly currentName: string | null;
  readonly translate: Translator;
}

export interface DisplayNamePageData {
  readonly title: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: object;
}

export interface DisplayNameLabels {
  readonly required: string;
  readonly taken: string;
  readonly invalid: string;
  readonly limit: string;
  readonly saveFailed: string;
}

/** The display-name step page's view model (task 4.3). */
export function buildDisplayNamePage(input: DisplayNamePageInput): DisplayNamePageData {
  const title = input.translate("displayName.title");

  return {
    title,
    breadcrumbs: [{ label: title, href: null }],
    viewModel: {
      currentName: input.currentName ?? "",
      returnTo: input.returnTo,
    },
  };
}

/** Translated strings the step page's browser script needs. */
export function displayNameLabels(translate: Translator): DisplayNameLabels {
  return {
    required: translate("displayName.required"),
    taken: translate("displayName.taken"),
    invalid: translate("displayName.invalid"),
    limit: translate("displayName.changeLimitShort"),
    saveFailed: translate("displayName.saveFailed"),
  };
}

/** Formats the date a change is allowed again, for API error responses that carry it. */
export function formatChangeDate(locale: Locale, iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
