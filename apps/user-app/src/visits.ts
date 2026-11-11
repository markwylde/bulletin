/**
 * Visits and the personal overlay (ADR 0006, task 6.3/6.4). The page renders only
 * placeholders; members load their overlay and guests beacon a view. Cached HTML never
 * contains either payload.
 */

import { CSRF_STORAGE_KEY } from "@bulletin/domain/auth/browser";
import { publishReactionStates } from "@bulletin/ui/islands/reactions/store";
import { publishReputationStates } from "@bulletin/ui/islands/reputation/store";
import { setFollowState } from "./follows/dom.ts";
import {
  applyOverlay,
  type OverlayCount,
  type OverlayDraft,
  type OverlayPayload,
  type OverlayTarget,
} from "./overlay/apply.ts";

function overlayElement(): Element | null {
  return document.querySelector("[data-overlay-ctx]");
}

function overlayContext(): string | null {
  return overlayElement()?.getAttribute("data-overlay-ctx") ?? null;
}

function overlayReadMarker(): { readonly lastReadAt?: string; readonly lastReadPostId?: string } {
  const element = overlayElement();
  const lastReadAt = element?.getAttribute("data-overlay-last-post-at");
  const lastReadPostId = element?.getAttribute("data-overlay-last-post-id");

  return {
    ...(lastReadAt === null || lastReadAt === undefined ? {} : { lastReadAt }),
    ...(lastReadPostId === null || lastReadPostId === undefined ? {} : { lastReadPostId }),
  };
}

function pageForumIds(): string[] {
  const ids = new Set<string>();

  for (const element of document.querySelectorAll("[data-overlay-forum]")) {
    const id = element.getAttribute("data-overlay-forum") ?? "";

    if (/^[1-9]\d{0,18}$/.test(id)) {
      ids.add(id);
    }
  }

  return [...ids];
}

function pagePostIds(): string[] {
  const ids = new Set<string>();

  for (const element of document.querySelectorAll("[data-post]")) {
    const id = element.getAttribute("data-post") ?? "";

    if (/^[1-9]\d{0,18}$/.test(id)) {
      ids.add(id);
    }
  }

  return [...ids];
}

function pageFollowTargets(): string[] {
  const targets = new Set<string>();

  for (const element of document.querySelectorAll("[data-follow-context]")) {
    const target = element.getAttribute("data-follow-context") ?? "";

    if (/^(topic|forum|member):[1-9]\d{0,18}$/.test(target)) {
      targets.add(target);
    }
  }

  return [...targets];
}

function pageTopicIds(): string[] {
  const ids = new Set<string>();

  for (const element of document.querySelectorAll("[data-overlay-context]")) {
    const context = element.getAttribute("data-overlay-context") ?? "";
    const topic = /^topic:([1-9]\d{0,18})$/.exec(context);

    if (topic?.[1] !== undefined) {
      ids.add(topic[1]);
    }
  }

  return [...ids];
}

/** The DOM adapter for the pure overlay applier (unread markers, counts and the CSRF token). */
const overlayTarget: OverlayTarget = {
  unreadSlots(topicId) {
    return [
      ...document.querySelectorAll(
        `[data-overlay-unread][data-overlay-context="topic:${CSS.escape(topicId)}"]`,
      ),
    ].map((slot) => ({
      markUnread() {
        slot.setAttribute("data-unread", "true");
        slot.textContent = "";
      },
    }));
  },

  forumUnreadSlots(forumId) {
    return [
      ...document.querySelectorAll(
        `[data-overlay-forum-unread][data-overlay-forum-id="${CSS.escape(forumId)}"]`,
      ),
    ].map((slot) => ({
      markUnread() {
        slot.setAttribute("data-unread", "true");
        slot.textContent = "";
      },
    }));
  },

  countSlots(name: OverlayCount) {
    return [...document.querySelectorAll<HTMLElement>(`[data-overlay-count="${name}"]`)].map(
      (slot) => ({
        setCount(count) {
          const label = slot.getAttribute("data-label");
          slot.textContent = String(count);
          slot.hidden = count <= 0;

          if (label !== null) {
            slot.setAttribute("aria-label", `${label}: ${count}`);
          }
        },
      }),
    );
  },

  storeCsrfToken(token) {
    try {
      sessionStorage.setItem(CSRF_STORAGE_KEY, token);
    } catch {
      // Storage can be unavailable (private mode); the overlay still applies.
    }
  },

  hideAnnouncement(announcementId) {
    const element = document.querySelector<HTMLElement>(
      `[data-announcement="${CSS.escape(announcementId)}"]`,
    );

    if (element !== null) {
      element.hidden = true;
    }
  },

  setDraft(draft: OverlayDraft) {
    window.dispatchEvent(new CustomEvent<OverlayDraft>("bulletin:draft", { detail: draft }));
  },

  setPollVoted(pollId, hasVoted) {
    window.dispatchEvent(new CustomEvent("bulletin:poll-voted", { detail: { pollId, hasVoted } }));
  },

  setFirstUnread(topicId, url) {
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      `[data-overlay-first-unread][data-overlay-context="topic:${CSS.escape(topicId)}"]`,
    )) {
      link.href = url;
      link.hidden = false;
    }
  },

  setEditablePosts(posts) {
    window.dispatchEvent(new CustomEvent("bulletin:editable-posts", { detail: posts }));
  },

  setFollow(context, following) {
    setFollowState(context, following);
  },

  setReactions(states) {
    publishReactionStates(states);
  },

  setReputation(states) {
    publishReputationStates(states);
  },

  setHideSignatures(hidden) {
    document.documentElement.toggleAttribute("data-hide-signatures", hidden);
  },
};

function draftContext(): string | null {
  return document.querySelector("[data-draft-context]")?.getAttribute("data-draft-context") ?? null;
}

async function loadOverlay(ctx: string): Promise<void> {
  try {
    const response = await fetch("/api/me/overlay", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bulletin-overlay": "1" },
      body: JSON.stringify({
        ctx,
        topics: pageTopicIds(),
        forums: pageForumIds(),
        posts: pagePostIds(),
        followTargets: pageFollowTargets(),
        ...overlayReadMarker(),
        ...(draftContext() === null ? {} : { draftContext: draftContext() }),
      }),
    });

    if (!response.ok) {
      return;
    }

    applyOverlay(overlayTarget, (await response.json()) as OverlayPayload);
    // A signal for tests and for scripts that need the private state before they run.
    document.documentElement.dataset.overlayApplied = "true";
  } catch {
    // The overlay is an enhancement; the page works without it.
  }
}

function sendBeacon(ctx: string): void {
  if (typeof navigator.sendBeacon !== "function") {
    return;
  }

  // `sendBeacon` cannot set headers; same-origin requests still carry Origin and cookies.
  navigator.sendBeacon(
    "/api/beacon",
    new Blob([JSON.stringify({ ctx })], { type: "application/json" }),
  );
}

// Member-only controls are absent from the shared fragment; the per-request shell reveals
// them, so cached HTML is identical for a member and a guest with the same capabilities.
const visitor = document.documentElement.dataset.visitor;

for (const element of document.querySelectorAll<HTMLElement>("[data-overlay-member-only]")) {
  element.hidden = visitor !== "member";
}

// Personal pages (account, notifications) have no content context, but the member still needs
// the overlay for the header counts; "board" is the supported context for those pages.
const ctx =
  overlayContext() ?? (document.documentElement.dataset.visitor === "member" ? "board" : null);

if (ctx !== null) {
  if (document.documentElement.dataset.visitor === "member") {
    void loadOverlay(ctx);
  } else {
    sendBeacon(ctx);
  }
}
