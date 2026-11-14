import { readAvatarPolicy, readMember, readNameHistory } from "@bulletin/domain/member";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import { avatarUrl, initialsSvg } from "../avatar.ts";
import type { BreadcrumbItem, LanguageSwitcherView } from "../theme/render.ts";
import { languageSwitcherView } from "../theme/render.ts";

export interface AccountPageInput {
  readonly sql: SQL;
  readonly memberId: string;
  readonly locale: Locale;
  readonly translate: Translator;
  /** The viewer's evaluated `avatar_upload` flag. */
  readonly avatarUploadEnabled?: boolean;
}

export interface AccountPageData {
  readonly title: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: object;
}

export interface AvatarLabels {
  readonly invalid: string;
  readonly tooLarge: string;
  readonly blocked: string;
  readonly notAllowed: string;
  readonly failed: string;
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
  readonly exportRequested: string;
  readonly exportError: string;
  readonly browsers: Readonly<Record<string, string>>;
}

/** Translated strings the avatar crop script needs. */
export function avatarLabels(translate: Translator): AvatarLabels {
  return {
    invalid: translate("account.avatar.invalid"),
    tooLarge: translate("account.avatar.tooLarge"),
    blocked: translate("account.avatar.blocked"),
    notAllowed: translate("account.avatar.notAllowed"),
    failed: translate("account.avatar.failed"),
  };
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
    exportRequested: translate("account.export.requested"),
    exportError: translate("account.export.error"),
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

  const [history, avatarPolicy] = await Promise.all([
    readNameHistory(input.sql, input.memberId),
    readAvatarPolicy(input.sql, input.memberId),
  ]);
  const formatter = new Intl.DateTimeFormat(input.locale, { dateStyle: "medium" });
  const language: LanguageSwitcherView = languageSwitcherView(input.locale, input.translate);
  const title = input.translate("account.title");

  return {
    title,
    breadcrumbs: [{ label: title, href: null }],
    viewModel: {
      displayName: member.displayName ?? "",
      profileUrl:
        member.displayName === null
          ? null
          : canonicalUrl("profile", input.memberId, member.displayName),
      avatar: {
        url: member.avatarHash === null ? null : avatarUrl(input.memberId, member.avatarHash, "lg"),
        initialsHtml: safeHtml(
          initialsSvg(input.memberId, member.displayName ?? input.translate("member.deletedName")),
        ),
        maxWidth: avatarPolicy?.maxWidth ?? 512,
        maxHeight: avatarPolicy?.maxHeight ?? 512,
      },
      history: history.map((entry) => ({
        oldName: entry.oldName,
        newName: entry.newName,
        iso: entry.changedAt.toISOString(),
        label: formatter.format(entry.changedAt),
      })),
      language,
      flags: { avatar_upload: input.avatarUploadEnabled === true },
    },
  };
}
