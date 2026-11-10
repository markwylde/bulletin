import { defineContract, type ViewModelContractRegistry } from "@bulletin/templates";

/** The view-model fields the demo route's cache tags depend on. */
export interface DemoViewModel {
  readonly forumId: string;
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
  deps: [],
  tags: ["board"],
  // Guests see the same board shell; the member session arrives through the overlay/API.
  cdnCacheable: true,
  requiredIslands: [],
});

export const loginContract = defineContract({
  route: "/auth/login",
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: [],
});

export const callbackContract = defineContract({
  route: "/auth/callback",
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: [],
});

/** Islands every demo state renders (the header); the content state adds the counter. */
export const DEMO_SHELL_ISLANDS = ["LanguageSwitcher"] as const;

export const demoContract = defineContract<DemoViewModel>({
  route: "/_demo/[id]",
  deps: [],
  tags: (model) => [`forum:${model.forumId}`],
  // Guests share the fixture forum page; members and unlock grants stay private (ADR 0006).
  cdnCacheable: true,
  requiredIslands: [...DEMO_SHELL_ISLANDS, "SpikeCounter"],
});

export const displayNameContract = defineContract({
  route: "/display-name",
  deps: [],
  tags: [],
  cdnCacheable: false,
  requiredIslands: ["LanguageSwitcher"],
});

export const accountContract = defineContract<AccountViewModel>({
  route: "/account",
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
  [displayNameContract.route]: displayNameContract,
  [accountContract.route]: accountContract,
};
