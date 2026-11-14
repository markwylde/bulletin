import { claimReauthDrafts, clearReauthDrafts } from "@bulletin/ui/islands/editor/drafts";
import {
  clearOfflineDrafts,
  listOfflineDrafts,
  type OfflineDraft,
  removeOfflineDraft,
} from "@bulletin/ui/islands/editor/offline-drafts";
import { currentMemberId, memberFetch } from "../auth/client.ts";
import { clientFlag } from "../client-flags.ts";
import { clientCsrfToken } from "../csrf.ts";

/**
 * The reconnect prompt and offline queue UI (ADR 0014). A submission that could not reach the
 * server is kept in IndexedDB; when the connection returns the member confirms sending it.
 * Drafts belong to the signed-in member and are wiped when that membership ends.
 */

interface Banner {
  readonly root: HTMLElement;
  readonly message: HTMLElement;
  readonly send: HTMLButtonElement;
  readonly discard: HTMLButtonElement;
}

function banner(): Banner | null {
  const root = document.querySelector<HTMLElement>("[data-offline-drafts]");
  const message = root?.querySelector<HTMLElement>("[data-offline-drafts-message]") ?? null;
  const send = root?.querySelector<HTMLButtonElement>("[data-offline-drafts-send]") ?? null;
  const discard = root?.querySelector<HTMLButtonElement>("[data-offline-drafts-discard]") ?? null;

  return root === null || message === null || send === null || discard === null
    ? null
    : { root, message, send, discard };
}

const draftContextSelector = "[data-draft-context]";
const documentRoot = document.documentElement;
const element = banner();
const memberIdFromShell = documentRoot.dataset.memberId ?? currentMemberId();
const authPath = window.location.pathname.startsWith("/auth/");

/**
 * A member shell was rendered by the server for this navigation, so its identity is current.
 * The offline page is always rendered as a guest, so a cached shell cannot be trusted until the
 * live session confirms it.
 */
let identityConfirmed = documentRoot.dataset.visitor === "member";
const initialMemberId = identityConfirmed ? memberIdFromShell : "";

async function clearMemberDrafts(): Promise<void> {
  clearReauthDrafts();
  await clearOfflineDrafts();
}

async function claimMember(memberId: string): Promise<void> {
  if (claimReauthDrafts(memberId)) {
    await clearOfflineDrafts();
  }
}

function publishMember(memberId: string): void {
  identityConfirmed = true;

  if (memberId === "") {
    delete documentRoot.dataset.memberId;
  } else {
    documentRoot.dataset.memberId = memberId;
  }

  window.dispatchEvent(new CustomEvent("bulletin:member", { detail: { memberId } }));
}

/**
 * The shell may have been cached while installed as a guest or another account, so its embedded
 * identity cannot authorise a destructive cleanup while offline. Confirm the live session over
 * the network first; a network error leaves the device data untouched.
 */
async function confirmIdentity(): Promise<void> {
  if (!navigator.onLine || authPath) {
    return;
  }

  try {
    const response = await fetch("/api/auth/session", {
      credentials: "include",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      if (response.status === 401) {
        const payload = (await response
          .clone()
          .json()
          .catch(() => null)) as {
          readonly code?: unknown;
        } | null;

        if (payload?.code !== "reauth_required") {
          await clearMemberDrafts();
          publishMember("");
        }
      }

      return;
    }

    const session = (await response.json()) as {
      readonly authenticated?: boolean;
      readonly memberId?: string | null;
    };

    if (session.authenticated === true && typeof session.memberId === "string") {
      await claimMember(session.memberId);
      publishMember(session.memberId);
      return;
    }

    delete documentRoot.dataset.memberId;
    await clearMemberDrafts();
    publishMember("");
  } catch {
    // Identity is unknown without a successful response; keep drafts for the next online visit.
  }
}

if (element !== null && clientFlag("pwa")) {
  let memberId = initialMemberId;
  let drafts: readonly OfflineDraft[] = [];
  let sending = false;

  const label = (name: string): string => element.root.dataset[name] ?? "";

  const render = (): void => {
    element.root.hidden = drafts.length === 0;
    element.message.textContent = navigator.onLine ? label("labelOnline") : label("labelOffline");
    element.send.disabled = !navigator.onLine || sending;
    element.discard.disabled = sending;
    element.send.textContent = sending ? label("labelSending") : label("labelSend");
    element.discard.textContent = label("labelDiscard");
  };

  const refresh = async (): Promise<void> => {
    // The offline shell is a guest page: never show queued text until the live session says
    // whose device this is (reviewer finding: reconnect never offered drafts).
    drafts = identityConfirmed && memberId !== "" ? await listOfflineDrafts(memberId) : [];
    render();
  };

  const sendAll = async (): Promise<void> => {
    if (sending || drafts.length === 0) {
      return;
    }

    sending = true;
    render();

    for (const draft of drafts) {
      const token = await clientCsrfToken();

      try {
        const response = await memberFetch(draft.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token === null ? {} : { "x-bulletin-csrf": token }),
          },
          body: draft.body,
        });

        if (!response.ok) {
          // A re-auth or revocation response has already been handled by the auth wrapper.
          sending = false;
          await refresh();
          return;
        }

        const body = (await response.json().catch(() => ({}))) as { readonly url?: unknown };
        await removeOfflineDraft(draft.id);

        if (typeof body.url === "string") {
          const target = new URL(body.url, window.location.href);

          // A reply's URL differs only by its anchor; assigning it would not reload the page.
          if (
            target.pathname === window.location.pathname &&
            target.search === window.location.search
          ) {
            window.location.reload();
          } else {
            window.location.assign(body.url);
          }

          return;
        }
      } catch {
        sending = false;
        await refresh();
        return;
      }
    }

    sending = false;
    await refresh();

    if (drafts.length === 0) {
      window.location.reload();
    }
  };

  element.send.addEventListener("click", () => {
    void sendAll();
  });
  element.discard.addEventListener("click", () => {
    void clearOfflineDrafts().then(() => {
      drafts = [];
      render();
    });
  });

  window.addEventListener("online", () => {
    void confirmIdentity().then(refresh);
  });
  window.addEventListener("offline", () => {
    render();
  });
  window.addEventListener("bulletin:offline-draft", () => {
    void refresh();
  });
  window.addEventListener("bulletin:member", (event) => {
    const detail = (event as CustomEvent<{ readonly memberId?: unknown }>).detail;
    const next = typeof detail?.memberId === "string" ? detail.memberId : "";
    memberId = next;
    identityConfirmed = true;

    if (next === "") {
      void clearMemberDrafts();
      drafts = [];
      render();
      return;
    }

    void claimMember(next).then(refresh);
  });

  void refresh();
}

// Run after the banner listeners exist: the response may confirm (or clear) the identity that
// decides whether queued drafts may be shown.
void confirmIdentity();

/** The editor context for a submission form, so a queued draft belongs to the right editor. */
export function draftContext(form: HTMLFormElement): string {
  return form.querySelector<HTMLElement>(draftContextSelector)?.dataset.draftContext ?? "";
}
