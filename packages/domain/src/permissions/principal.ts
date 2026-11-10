/**
 * A permission principal is either a member ID or the explicit guest principal. Guests are a
 * real group (ADR 0004), so every evaluator resolves them through the same mask/settings path.
 */
export interface GuestPrincipal {
  readonly kind: "guest";
}

export type ViewerPrincipal = string | GuestPrincipal;

export const GUEST_PRINCIPAL: GuestPrincipal = { kind: "guest" };

export function isGuestPrincipal(principal: ViewerPrincipal): principal is GuestPrincipal {
  return typeof principal !== "string";
}

/** The member ID for a member principal, or `null` for a guest. */
export function principalMemberId(principal: ViewerPrincipal): string | null {
  return typeof principal === "string" ? principal : null;
}

/** The synthetic member ID stored on a guest's compiled snapshot. */
export const GUEST_SNAPSHOT_MEMBER_ID = "guest";
