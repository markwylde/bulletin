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
  tags: [GLOBAL_CACHE_TAGS.board, GLOBAL_CACHE_TAGS.announcements, GLOBAL_CACHE_TAGS.leaderboards],
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
  templates: { page: "account", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

/** The member's own profile editor: personal, never shared (ADR 0006). */
export const profileEditContract = defineContract<AccountViewModel>({
  route: "/account/profile",
  templates: {
    page: "account-profile",
    regions: ["header", "breadcrumbs", "empty", "footer"],
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
    GLOBAL_CACHE_TAGS.board,
  ],
  cdnCacheable: true,
  requiredIslands: ["LanguageSwitcher"],
});

export const notificationPreferencesContract = defineContract<AccountViewModel>({
  route: "/account/notifications/preferences",
  templates: {
    page: "account-notification-preferences",
    regions: ["header", "breadcrumbs", "empty", "footer"],
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
    regions: ["header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const followsContract = defineContract<AccountViewModel>({
  route: "/account/follows",
  templates: { page: "account-follows", regions: ["header", "breadcrumbs", "empty", "footer"] },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const attachmentsContract = defineContract<AccountViewModel>({
  route: "/account/attachments",
  templates: {
    page: "account-attachments",
    regions: ["header", "breadcrumbs", "empty", "footer"],
  },
  deps: [],
  tags: (model) => [`member:${model.memberId}`],
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
  tags: [GLOBAL_CACHE_TAGS.board],
  cdnCacheable: true,
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

export const ROUTE_CONTRACTS: ViewModelContractRegistry = {
  [homeContract.route]: homeContract,
  [loginContract.route]: loginContract,
  [callbackContract.route]: callbackContract,
  [demoContract.route]: demoContract,
  [forumContract.route]: forumContract,
  [topicContract.route]: topicContract,
  [displayNameContract.route]: displayNameContract,
  [accountContract.route]: accountContract,
  [profileEditContract.route]: profileEditContract,
  [profileContract.route]: profileContract,
  [memberListContract.route]: memberListContract,
  [onlineContract.route]: onlineContract,
  [leaderboardContract.route]: leaderboardContract,
  [unsubscribeContract.route]: unsubscribeContract,
  [unsubscribeConfirmedContract.route]: unsubscribeConfirmedContract,
  [notificationPreferencesContract.route]: notificationPreferencesContract,
  [notificationsContract.route]: notificationsContract,
  [followsContract.route]: followsContract,
  [attachmentsContract.route]: attachmentsContract,
};
