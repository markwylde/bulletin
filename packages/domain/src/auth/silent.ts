import { safeReturnTo } from "./return-to.ts";

export interface NavigationReauthInput {
  readonly method: string;
  readonly secFetchMode: string | null;
  readonly pathname: string;
  readonly reauthAt: string | null;
  readonly now?: Date;
}

const SKIP_PREFIXES = ["/api/", "/health/", "/auth/", "/_", "/@", "/src/"];

/** True when a top-level HTML navigation should start a silent re-auth (ADR 0018). */
export function shouldRedirectToReauth(input: NavigationReauthInput): boolean {
  if (input.method.toUpperCase() !== "GET" || input.secFetchMode !== "navigate") {
    return false;
  }

  if (
    input.reauthAt === null ||
    SKIP_PREFIXES.some((prefix) => input.pathname.startsWith(prefix))
  ) {
    return false;
  }

  const reauthAt = Date.parse(input.reauthAt);
  return Number.isFinite(reauthAt) && (input.now ?? new Date()).getTime() > reauthAt;
}

export function reauthRedirectUrl(returnTo: string): string {
  const safe = safeReturnTo(returnTo) ?? "/";
  return `/api/auth/refresh?return_to=${encodeURIComponent(safe)}`;
}
