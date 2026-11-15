import {
  forumAnnouncementsTag,
  forumTag,
  GLOBAL_CACHE_TAGS,
  postSnapshotsTag,
  topicPagesTag,
  topicTag,
} from "@bulletin/cache";
import { defineContract, type ViewModelContractRegistry } from "@bulletin/templates";

/** The view-model fields the demo route's cache tags depend on. */
export interface DemoViewModel {
  readonly forumId: string;
  /** The editor demo embeds the emoticon picker, so it also carries the emoticon tag. */
  readonly embedsEditor?: boolean;
}

/** The view-model fields the forum page's tags depend on. */
export interface ForumViewModel {
  readonly forumId: string;
  readonly ancestorIds: readonly string[];
}

/** The view-model fields the topic route's tags depend on. */
export interface TopicViewModel {
  readonly topicId: string;
  /** The topic forum and every ancestor (breadcrumbs and forum links). */
  readonly forumIds: readonly string[];
  /** Topics whose quoted posts appear on this page. */
  readonly quoteTopicIds?: readonly string[];
  /** Posts whose snapshots are quoted on this page. */
  readonly quotePostIds?: readonly string[];
  /** Forums whose content is quoted: their read bit is part of the variant. */
  readonly quotedForumIds?: readonly string[];
}

/** The view-model fields the account route's cache tags depend on. */
export interface AccountViewModel {
  readonly memberId: string;
}

/** The profile route's own member tag. */
export interface ReportViewModel {
  readonly reportId: string;
}

/** The profile route's own member tag. */
export interface ProfileViewModel {
  readonly memberId: string;
}

/**
 * Every user-app page declares a view-model contract (ADR 0006, 0008; tasks 2.4 and 3.2). The
 * architecture test fails the build when a page has no entry here or an entry has no page.
 */

export const homeContract = defineContract({
  route: "/",
  templates: { page: "home", regions: ["header", "footer"] },
  deps: [],
  tags: [
    GLOBAL_CACHE_TAGS.board,
    GLOBAL_CACHE_TAGS.announcements,
    GLOBAL_CACHE_TAGS.leaderboards,
    GLOBAL_CACHE_TAGS.online,
  ],
  // Guests see the same board shell; the member session arrives through the overlay/API.
  cdnCacheable: true,
  requiredIslands: ["LanguageSwitcher"],
});

export const loginContract = defineContract({
  route: "/auth/login",
  templates: { page: "login", regions: ["header", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const offlineContract = defineContract({
  route: "/offline",
  templates: { page: "offline", regions: ["header", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const callbackContract = defineContract({
  route: "/auth/callback",
  templates: { page: "callback", regions: ["header", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** Islands every demo state renders (the header); the content state adds the counter. */
export const DEMO_SHELL_ISLANDS = ["LanguageSwitcher"] as const;

export const demoContract = defineContract<DemoViewModel>({
  route: "/_demo/[id]",
  templates: { page: "demo", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  // The header/footer carry the board name, so a board settings save must invalidate it too.
  tags: (model) => [
    `forum:${model.forumId}`,
    GLOBAL_CACHE_TAGS.board,
    ...(model.embedsEditor === true ? [GLOBAL_CACHE_TAGS.emoticons] : []),
  ],
  // Guests share the fixture forum page; members and unlock grants stay private (ADR 0006).
  cdnCacheable: true,
  requiredIslands: [...DEMO_SHELL_ISLANDS, "SpikeCounter"],
});

/** The real forum page: its own content, ancestors' breadcrumbs, the shell and notices. */
export const forumContract = defineContract<ForumViewModel>({
  route: "/forum/[ref]",
  templates: { page: "forum", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: (model) =>
    [
      GLOBAL_CACHE_TAGS.board,
      GLOBAL_CACHE_TAGS.filters,
      GLOBAL_CACHE_TAGS.announcements,
      forumAnnouncementsTag(model.forumId),
      ...model.ancestorIds.map(forumTag),
      forumTag(model.forumId),
    ].filter((value, index, all) => all.indexOf(value) === index),
  cdnCacheable: true,
  requiredIslands: ["LanguageSwitcher"],
});

export const topicContract = defineContract<TopicViewModel>({
  route: "/topic/[ref]",
  templates: { page: "topic", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  // A quote source's edit/delete and the topic's own counters invalidate the page.
  tags: (model) => [
    topicTag(model.topicId),
    topicPagesTag(model.topicId),
    GLOBAL_CACHE_TAGS.board,
    GLOBAL_CACHE_TAGS.filters,
    ...model.forumIds.map(forumTag),
    ...(model.quoteTopicIds ?? []).map(topicTag),
    ...(model.quotePostIds ?? []).map(postSnapshotsTag),
    ...(model.quotedForumIds ?? []).map(forumTag),
  ],
  cdnCacheable: true,
  requiredIslands: ["LanguageSwitcher"],
});

export const displayNameContract = defineContract({
  route: "/display-name",
  templates: {
    page: "display-name",
    regions: ["header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const accountContract = defineContract<AccountViewModel>({
  route: "/account",
  templates: {
    page: "account",
    regions: ["account-nav", "header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** The member's privacy controls: personal, never shared (ADR 0006, 0012). */
export const privacyContract = defineContract<AccountViewModel>({
  route: "/account/privacy",
  templates: {
    page: "account-privacy",
    regions: ["account-nav", "header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** The admin-managed privacy policy is public but always rendered fresh. */
export const privacyPolicyContract = defineContract({
  route: "/privacy",
  templates: { page: "privacy-policy", regions: ["header", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** The member's own profile editor: personal, never shared (ADR 0006). */
export const profileEditContract = defineContract<AccountViewModel>({
  route: "/account/profile",
  templates: {
    page: "account-profile",
    regions: ["account-nav", "header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`, GLOBAL_CACHE_TAGS.profileFields],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/**
 * A public profile is cached per viewer field-visibility class (ADR 0005, 0006). The route
 * adds the recent-post forums' read bits to the variant key at render time.
 */
export const profileContract = defineContract<ProfileViewModel>({
  route: "/profile/[ref]",
  templates: { page: "profile", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: (model) => [
    `member:${model.memberId}`,
    GLOBAL_CACHE_TAGS.profileFields,
    GLOBAL_CACHE_TAGS.badges,
    GLOBAL_CACHE_TAGS.ranks,
    GLOBAL_CACHE_TAGS.board,
    GLOBAL_CACHE_TAGS.filters,
  ],
  cdnCacheable: true,
  requiredIslands: ["LanguageSwitcher"],
});

export const notificationPreferencesContract = defineContract<AccountViewModel>({
  route: "/account/notifications/preferences",
  templates: {
    page: "account-notification-preferences",
    regions: ["account-nav", "header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const unsubscribeContract = defineContract({
  route: "/unsubscribe",
  templates: { page: "unsubscribe", regions: ["header", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const unsubscribeConfirmedContract = defineContract({
  route: "/unsubscribe/confirmed",
  templates: { page: "unsubscribe", regions: ["header", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const notificationsContract = defineContract<AccountViewModel>({
  route: "/account/notifications",
  templates: {
    page: "account-notifications",
    regions: ["account-nav", "header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const followsContract = defineContract<AccountViewModel>({
  route: "/account/follows",
  templates: {
    page: "account-follows",
    regions: ["account-nav", "header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const attachmentsContract = defineContract<AccountViewModel>({
  route: "/account/attachments",
  templates: {
    page: "account-attachments",
    regions: ["account-nav", "header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** Personal conversation lists and pages are never shared or stored (design). */
/** The member's own warning history; staff notes are never included. */
export const warningsContract = defineContract<AccountViewModel>({
  route: "/account/warnings",
  templates: {
    page: "account-warnings",
    regions: ["account-nav", "header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** A moderator's full warning view for one member, including staff notes. */
export const moderationWarningsContract = defineContract<AccountViewModel>({
  route: "/moderation/warnings/[memberId]",
  templates: {
    page: "moderation-warnings",
    regions: ["header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** The moderator's personal approval queue; never shared or stored (ADR 0006). */
export const moderationQueueContract = defineContract<AccountViewModel>({
  route: "/moderation/queue",
  templates: {
    page: "moderation-queue",
    regions: ["header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** A forum moderator's scoped moderation log; admins see every entry through the API. */
export const moderationLogContract = defineContract<AccountViewModel>({
  route: "/moderation/log",
  templates: {
    page: "moderation-log",
    regions: ["header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: () => ["moderation-log"],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** The report centre list; participants see only reports their permissions scope. */
export const moderationReportsContract = defineContract<AccountViewModel>({
  route: "/moderation/reports",
  templates: {
    page: "moderation-reports",
    regions: ["header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: () => ["reports"],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** One report; PM context is private and audited per view. */
export const moderationReportContract = defineContract<ReportViewModel>({
  route: "/moderation/reports/[id]",
  templates: {
    page: "moderation-report",
    regions: ["header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`report:${model.reportId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const conversationsContract = defineContract<AccountViewModel>({
  route: "/conversations",
  templates: { page: "conversations", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: (model) => [`member:${model.memberId}`, GLOBAL_CACHE_TAGS.filters],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const conversationContract = defineContract<AccountViewModel>({
  route: "/conversations/[ref]",
  templates: { page: "conversation", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: (model) => [`member:${model.memberId}`, GLOBAL_CACHE_TAGS.filters],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** The member directory (task 4.1); hidden members change the variant by permission. */
export const memberListContract = defineContract({
  route: "/members",
  templates: { page: "members", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: [GLOBAL_CACHE_TAGS.directory, GLOBAL_CACHE_TAGS.board],
  cdnCacheable: true,
  requiredIslands: ["LanguageSwitcher"],
});

/** Who's online; the route adds every forum read bit to the variant at render time. */
export const onlineContract = defineContract({
  route: "/members/online",
  templates: { page: "online", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: [GLOBAL_CACHE_TAGS.board, GLOBAL_CACHE_TAGS.online],
  cdnCacheable: true,
  requiredIslands: ["LanguageSwitcher"],
});

/** Plugin pages are themed but private (their HTML is never shared through the CDN). */
export const pluginPageContract = defineContract({
  route: "/p/[...ref]",
  templates: { page: "plugin", regions: ["header", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** Guest-visible leaderboards; the variant is the current Guests-readable forum set. */
export const leaderboardContract = defineContract({
  route: "/leaderboards",
  templates: { page: "leaderboards", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: [GLOBAL_CACHE_TAGS.leaderboards, GLOBAL_CACHE_TAGS.board],
  cdnCacheable: true,
  requiredIslands: ["LanguageSwitcher"],
});

/** Search results are viewer-dependent and never shareable; the routes set no-store. */
export const searchContract = defineContract({
  route: "/search",
  templates: { page: "search", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const searchMemberContract = defineContract({
  route: "/search/member/[ref]",
  templates: { page: "search", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const searchNewContract = defineContract({
  route: "/search/new",
  templates: { page: "search", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/**
 * The public API documentation (task 2.3). It renders the generated OpenAPI document and is
 * the same for every guest, so the CDN may cache it; a member sees the same HTML.
 */
export const apiDocsContract = defineContract({
  route: "/api-docs",
  templates: { page: "api-docs", regions: ["header", "breadcrumbs", "footer"] },
  deps: [],
  tags: [],
  cdnCacheable: true,
  requiredIslands: ["LanguageSwitcher", "ApiDocs"],
});

/** The member's own API keys (task 4.1): personal metadata, never shared or stored. */
export const apiKeysContract = defineContract<AccountViewModel>({
  route: "/account/api-keys",
  templates: {
    page: "account-api-keys",
    regions: ["account-nav", "header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const ROUTE_CONTRACTS: ViewModelContractRegistry = {
  [homeContract.route]: homeContract,
  [apiDocsContract.route]: apiDocsContract,
  [apiKeysContract.route]: apiKeysContract,
  [loginContract.route]: loginContract,
  [offlineContract.route]: offlineContract,
  [callbackContract.route]: callbackContract,
  [demoContract.route]: demoContract,
  [forumContract.route]: forumContract,
  [topicContract.route]: topicContract,
  [displayNameContract.route]: displayNameContract,
  [accountContract.route]: accountContract,
  [privacyContract.route]: privacyContract,
  [privacyPolicyContract.route]: privacyPolicyContract,
  [profileEditContract.route]: profileEditContract,
  [profileContract.route]: profileContract,
  [memberListContract.route]: memberListContract,
  [onlineContract.route]: onlineContract,
  [leaderboardContract.route]: leaderboardContract,
  [pluginPageContract.route]: pluginPageContract,
  [unsubscribeContract.route]: unsubscribeContract,
  [unsubscribeConfirmedContract.route]: unsubscribeConfirmedContract,
  [notificationPreferencesContract.route]: notificationPreferencesContract,
  [notificationsContract.route]: notificationsContract,
  [followsContract.route]: followsContract,
  [attachmentsContract.route]: attachmentsContract,
  [moderationQueueContract.route]: moderationQueueContract,
  [moderationLogContract.route]: moderationLogContract,
  [warningsContract.route]: warningsContract,
  [moderationWarningsContract.route]: moderationWarningsContract,
  [moderationReportsContract.route]: moderationReportsContract,
  [moderationReportContract.route]: moderationReportContract,
  [conversationsContract.route]: conversationsContract,
  [conversationContract.route]: conversationContract,
  [searchContract.route]: searchContract,
  [searchMemberContract.route]: searchMemberContract,
  [searchNewContract.route]: searchNewContract,
};
