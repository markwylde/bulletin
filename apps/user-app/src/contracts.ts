import { defineContract, type ViewModelContractRegistry } from "@bulletin/templates";

/** The view-model fields the demo route's cache tags depend on. */
export interface SpikeViewModel {
  readonly theme: string;
  readonly plugins: number;
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

export const spikeRenderingContract = defineContract<SpikeViewModel>({
  route: "/spike/rendering",
  deps: [],
  tags: (model) => [`theme:${model.theme}`, "plugins"],
  cdnCacheable: false,
  requiredIslands: ["SpikeCounter"],
});

export const ROUTE_CONTRACTS: ViewModelContractRegistry = {
  [homeContract.route]: homeContract,
  [loginContract.route]: loginContract,
  [callbackContract.route]: callbackContract,
  [spikeRenderingContract.route]: spikeRenderingContract,
};
