import { forumAnnouncementsTag, forumTag, GLOBAL_CACHE_TAGS } from "@bulletin/cache";
import { defineContract, type ViewModelContractRegistry } from "@bulletin/templates";

/** The view-model fields the demo route's cache tags depend on. */
export interface DemoViewModel {
  readonly forumId: string;
}

/** The view-model fields the forum page's tags depend on. */
export interface ForumViewModel {
  readonly forumId: string;
  readonly ancestorIds: readonly string[];
}

/** The view-model fields the account route's cache tags depend on. */
export interface AccountViewModel {
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
  tags: [GLOBAL_CACHE_TAGS.board, GLOBAL_CACHE_TAGS.announcements],
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
  tags: (model) => [`forum:${model.forumId}`, GLOBAL_CACHE_TAGS.board],
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

export const ROUTE_CONTRACTS: ViewModelContractRegistry = {
  [homeContract.route]: homeContract,
  [loginContract.route]: loginContract,
  [callbackContract.route]: callbackContract,
  [demoContract.route]: demoContract,
  [forumContract.route]: forumContract,
  [displayNameContract.route]: displayNameContract,
  [accountContract.route]: accountContract,
};
