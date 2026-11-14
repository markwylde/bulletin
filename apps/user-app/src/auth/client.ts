import {
  type AuthFetch,
  clearStashedRequest,
  createAuthFetch,
} from "@bulletin/domain/auth/browser";
import { clearReauthDrafts } from "@bulletin/ui/islands/editor/drafts";
import { clearOfflineDrafts } from "@bulletin/ui/islands/editor/offline-drafts";

/** The signed-in member from the shell, set by the auth and editor bootstrap. */
export function currentMemberId(): string {
  return document.documentElement.dataset.memberId ?? "";
}

export function rememberMember(memberId: string): void {
  if (memberId === "") {
    delete document.documentElement.dataset.memberId;
  } else {
    document.documentElement.dataset.memberId = memberId;
  }

  window.dispatchEvent(new CustomEvent("bulletin:member", { detail: { memberId } }));
}

/** Re-auth keeps drafts; the own member is continuing (ADR 0014, ADR 0018). */
export function showReauthPrompt(): void {
  window.dispatchEvent(new CustomEvent("bulletin:reauth"));

  const banner = document.querySelector<HTMLElement>("[data-stream-reauth]");
  const link = document.querySelector<HTMLAnchorElement>("[data-stream-reauth-continue]");

  if (link !== null) {
    link.href = `/api/auth/refresh?return_to=${encodeURIComponent(
      window.location.pathname + window.location.search,
    )}`;
  }

  if (banner !== null) {
    banner.hidden = false;
  }
}

/**
 * Removes whatever the signed-in member left on this device. Static assets in the service
 * worker's cache are not personal data and stay, so the app still opens offline (ADR 0014).
 */
export async function clearLocalMemberData(): Promise<void> {
  clearReauthDrafts();
  clearStashedRequest();
  await clearOfflineDrafts();
}

/** A revoked session is not re-auth: drop local member data and show the logged-out app. */
export function sessionRevoked(): void {
  void clearLocalMemberData().finally(() => {
    window.location.reload();
  });
}

/**
 * The fetch wrapper for member actions. It stashes a request on `reauth_required` (the member
 * returns to it) and clears local data on any other 401 (the session is gone).
 */
export const memberFetch: AuthFetch = createAuthFetch({
  ownerId: () => currentMemberId(),
  onReauthRequired: () => showReauthPrompt(),
  onSessionRevoked: () => sessionRevoked(),
});
