import {
  type CapabilityBit,
  type CapabilityDep,
  isForumAction,
  isModeratorPower,
} from "@bulletin/domain/permissions";

/** Static tags, or a function when the tags depend on the view model (e.g. `forum:{id}`). */
export type ContractTags<TModel> = readonly string[] | ((model: TModel) => readonly string[]);

/**
 * The per-route declaration every user-app route ships (design of `rendering-and-caching`):
 * which capability bits the view model reads, which cache tags the page depends on, whether
 * guests may receive it from the CDN, and which islands the theme may not omit.
 */
/** The theme templates one route actually composes (page plus regions). */
export interface TemplateComposition {
  readonly page: string;
  readonly regions: readonly string[];
}

export interface ViewModelContract<TModel = Readonly<Record<string, unknown>>> {
  /** Canonical route pattern, e.g. `/` or `/_demo/[id]`. */
  readonly route: string;
  /** The templates this route renders, so island checks look only at its composition. */
  readonly templates: TemplateComposition;
  /** Capability bits the view model reads (ADR 0005). */
  readonly deps: readonly CapabilityDep[];
  /** Cache tags the rendered page depends on (ADR 0006). */
  readonly tags: ContractTags<TModel>;
  /** True when guests can receive this page from the CDN (ADR 0006). */
  readonly cdnCacheable: boolean;
  /** Islands the page cannot work without (ADR 0008). */
  readonly requiredIslands: readonly string[];
}

/** Every contract in a registry, with its view-model type erased for validation. */
export type ViewModelContractRegistry = Readonly<Record<string, ViewModelContract<never>>>;

export interface ContractProblem {
  readonly route: string;
  readonly message: string;
}

const ROUTE_PATTERN = /^\/[a-z0-9\-._~[\]/]*$/i;
const TAG_PATTERN = /^[a-z][a-z0-9_]*(:[A-Za-z0-9_.-]+)*$/;

function isCapabilityBit(value: string): value is CapabilityBit {
  return isForumAction(value) || isModeratorPower(value);
}

/** Declares a route contract; identity today, the single place to add defaults later. */
export function defineContract<TModel>(
  contract: ViewModelContract<TModel>,
): ViewModelContract<TModel> {
  return contract;
}

/** Resolves the declared cache tags for one view model. */
export function contractTags<TModel>(
  contract: ViewModelContract<TModel>,
  model: TModel,
): readonly string[] {
  return typeof contract.tags === "function" ? contract.tags(model) : contract.tags;
}

/**
 * Validates one contract against the platform's registries. CI runs this for every route so a
 * typo in a capability bit, tag or island name fails the build instead of a page.
 */
export function validateContract(
  contract: ViewModelContract<never>,
  knownIslands: readonly string[],
): readonly ContractProblem[] {
  const problems: ContractProblem[] = [];
  const route = contract.route;
  const fail = (message: string): void => {
    problems.push({ route, message });
  };

  if (!ROUTE_PATTERN.test(route) || (route.length > 1 && route.endsWith("/"))) {
    fail(`route "${route}" is not a canonical path starting with "/"`);
  }

  const seenDeps = new Set<string>();

  for (const dep of contract.deps) {
    if (dep.forumId.trim() === "") {
      fail("a capability dep has an empty forumId");
    }

    if (!isCapabilityBit(dep.bit)) {
      fail(`capability dep uses unknown bit "${dep.bit}" on forum ${dep.forumId}`);
    }

    const key = `${dep.forumId}:${dep.bit}`;

    if (seenDeps.has(key)) {
      fail(`capability dep ${key} is declared twice`);
    }

    seenDeps.add(key);
  }

  // Function tags depend on the view model, so their values are asserted by the route's own
  // contract test; the registry check still requires an explicit declaration.
  const tags = contract.tags;

  if (typeof tags !== "function") {
    for (const tag of tags) {
      if (!TAG_PATTERN.test(tag)) {
        fail(`cache tag "${tag}" is not a valid tag name`);
      }
    }
  }

  if (contract.templates.page.trim() === "") {
    fail("declares no page template");
  }

  for (const region of contract.templates.regions) {
    if (region.trim() === "") {
      fail("declares an empty region template");
    }
  }

  for (const island of contract.requiredIslands) {
    if (!knownIslands.includes(island)) {
      fail(`required island "${island}" is not in the island registry`);
    }
  }

  return problems;
}

/** Validates every contract in a registry; CI asserts the result is empty. */
export function validateContracts(
  registry: ViewModelContractRegistry,
  knownIslands: readonly string[],
): readonly ContractProblem[] {
  return Object.values(registry).flatMap((contract) => validateContract(contract, knownIslands));
}

/**
 * Finds the contract for a request path: exact matches first, then `[param]` segments. The
 * caller renders with the contract's deps, tags and CDN eligibility.
 */
export function findContract(
  registry: ViewModelContractRegistry,
  pathname: string,
): ViewModelContract<never> | undefined {
  const exact = registry[pathname];

  if (exact !== undefined) {
    return exact;
  }

  const segments = splitPath(pathname);

  for (const contract of Object.values(registry)) {
    const pattern = splitPath(contract.route);

    if (pattern.length !== segments.length) {
      continue;
    }

    const matches = pattern.every(
      (part, index) => part.startsWith("[") || part === segments[index],
    );

    if (matches) {
      return contract;
    }
  }

  return undefined;
}

function splitPath(path: string): readonly string[] {
  return path.split("/").filter((part) => part !== "");
}
