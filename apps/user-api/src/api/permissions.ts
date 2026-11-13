import { type ApiPrincipal, isApiKeyPrincipal } from "@bulletin/domain/api";
import { resolveMemberLocale } from "@bulletin/domain/member";
import {
  CapabilityView,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
  type PermissionSnapshot,
  type ViewerPrincipal,
} from "@bulletin/domain/permissions";
import type { Locale } from "@bulletin/i18n";
import type { SQL } from "bun";

export interface ApiPermissionContext {
  /** The member or guest the key acts as in `can()` (ADR 0016). */
  readonly viewer: ViewerPrincipal;
  readonly tree: Awaited<ReturnType<typeof loadForumTree>>;
  readonly snapshot: PermissionSnapshot;
  readonly capability: CapabilityView;
}

/** One key/guest permission load per request; session grants do not exist for API keys. */
export async function loadApiPermissions(
  sql: SQL,
  principal: ApiPrincipal,
): Promise<ApiPermissionContext> {
  const viewer = isApiKeyPrincipal(principal) ? principal.memberId : GUEST_PRINCIPAL;
  const tree = await loadForumTree(sql);
  const snapshot = await loadPermissionSnapshot(sql, viewer, { tree, sessionId: null });
  const capability = new CapabilityView({
    tree: snapshot.tree,
    bits: snapshot.bits,
    unlocked: snapshot.unlocked,
    view: "public-api",
  });

  return { viewer, tree, snapshot, capability };
}

/** Members read API content in their own language; guests use the board default. */
export async function apiLocale(
  sql: SQL,
  principal: ApiPrincipal,
  boardDefault: Locale,
): Promise<Locale> {
  return isApiKeyPrincipal(principal) ? resolveMemberLocale(sql, principal.memberId) : boardDefault;
}

export function pageNumber(value: string | undefined, fallback = 1): number {
  return value !== undefined && /^\d{1,6}$/.test(value) ? Math.max(1, Number(value)) : fallback;
}

export function pageSize(value: string | undefined, fallback: number): number {
  return value !== undefined && /^\d{1,3}$/.test(value)
    ? Math.min(100, Math.max(1, Number(value)))
    : Math.min(100, Math.max(1, fallback));
}
