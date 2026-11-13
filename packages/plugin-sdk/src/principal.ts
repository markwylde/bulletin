import type { ViewerContext } from "./hooks.ts";

/**
 * Viewer-context principal (ADR 0009): a plugin never reads more than the intersection of
 *
 *   - what its approved capabilities allow,
 *   - what the current viewer may read,
 *   - what the plugin's background service principal may read.
 *
 * Core APIs evaluate the viewer and service-principal checks with `can()`; the broker only
 * forwards a call when the capability check passes. Keeping the intersection as a small pure
 * function makes the privileged-read-through case directly testable.
 */

export interface ServicePrincipal {
  readonly memberId: string | null;
  /** Scopes the service member was explicitly granted at install or later. */
  readonly scopes: readonly string[];
}

export interface AccessDecision {
  /** The plugin manifest approved this operation/capability. */
  readonly capability: boolean;
  /** `can()` for the current viewer, evaluated by the core API. */
  readonly viewer: boolean;
  /** `can()` for the plugin's service principal, evaluated by the core API. */
  readonly service: boolean;
}

export function allowsAccess(decision: AccessDecision): boolean {
  return decision.capability && decision.viewer && decision.service;
}

export interface PrincipalInput {
  readonly viewer: ViewerContext;
  readonly servicePrincipal: ServicePrincipal;
  readonly capabilities: readonly string[];
}

export interface Principal {
  readonly viewer: ViewerContext;
  readonly servicePrincipal: ServicePrincipal;
  readonly capabilities: ReadonlySet<string>;
  /** True only when all three sources allow the operation. */
  can(decision: Omit<AccessDecision, "capability"> & { readonly capability?: string }): boolean;
}

export function createPrincipal(input: PrincipalInput): Principal {
  const capabilities = new Set(input.capabilities);

  return {
    viewer: input.viewer,
    servicePrincipal: input.servicePrincipal,
    capabilities,
    can(decision) {
      return allowsAccess({
        capability: decision.capability === undefined || capabilities.has(decision.capability),
        viewer: decision.viewer,
        service: decision.service,
      });
    },
  };
}

/** The viewer used for a request that has no session: a guest. */
export const GUEST: ViewerContext = { memberId: null };

/** Background work always uses the plugin's service principal, never a viewer. */
export const BACKGROUND: ViewerContext = { memberId: null };
