import { readMember, readNameHistory } from "@bulletin/domain/member";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { BreadcrumbItem, LanguageSwitcherView } from "../theme/render.ts";
import { languageSwitcherView } from "../theme/render.ts";

export interface AccountPageInput {
  readonly sql: SQL;
  readonly memberId: string;
  readonly locale: Locale;
  readonly translate: Translator;
}

export interface AccountPageData {
  readonly title: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: object;
}

export interface AccountLabels {
  readonly saved: string;
  readonly saveFailed: string;
  readonly required: string;
  readonly taken: string;
  readonly invalid: string;
  readonly limit: string;
  readonly sessionsLoading: string;
  readonly sessionsError: string;
  readonly current: string;
  readonly lastSeen: string;
  readonly unknownBrowser: string;
  readonly browsers: Readonly<Record<string, string>>;
}

/** Translated strings the account page's browser script needs. */
export function accountLabels(translate: Translator): AccountLabels {
  return {
    saved: translate("account.displayName.saved"),
    saveFailed: translate("account.saveFailed"),
    required: translate("displayName.required"),
    taken: translate("displayName.taken"),
    invalid: translate("displayName.invalid"),
    limit: translate("displayName.changeLimitShort"),
    sessionsLoading: translate("account.sessions.loading"),
    sessionsError: translate("account.sessions.error"),
    current: translate("account.sessions.current"),
    lastSeen: translate("account.sessions.lastSeen"),
    unknownBrowser: translate("account.sessions.unknownBrowser"),
    browsers: {
      chrome: translate("account.browser.chrome"),
      firefox: translate("account.browser.firefox"),
      safari: translate("account.browser.safari"),
      edge: translate("account.browser.edge"),
      opera: translate("account.browser.opera"),
      samsung: translate("account.browser.samsung"),
      other: translate("account.browser.other"),
    },
  };
}

/** Display name, change history and language for the account page (task 4.3). */
export async function buildAccountPage(input: AccountPageInput): Promise<AccountPageData | null> {
  const member = await readMember(input.sql, input.memberId);

  if (member === null) {
    return null;
  }

  const history = await readNameHistory(input.sql, input.memberId);
  const formatter = new Intl.DateTimeFormat(input.locale, { dateStyle: "medium" });
  const language: LanguageSwitcherView = languageSwitcherView(input.locale, input.translate);
  const title = input.translate("account.title");

  return {
    title,
    breadcrumbs: [{ label: title, href: null }],
    viewModel: {
      displayName: member.displayName ?? "",
      history: history.map((entry) => ({
        oldName: entry.oldName,
        newName: entry.newName,
        iso: entry.changedAt.toISOString(),
        label: formatter.format(entry.changedAt),
      })),
      language,
    },
  };
}
