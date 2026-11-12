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
  type OverlayHeldPost,
  type OverlayHeldTopic,
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
function heldLabel(): string {
  return (
    document.querySelector("[data-label-unapproved]")?.getAttribute("data-label-unapproved") ?? ""
  );
}

function heldPostBlock(post: OverlayHeldPost): HTMLElement {
  const row = document.createElement("li");
  row.className = "bl-post bl-post--unapproved";
  row.id = `post-${post.postId}`;
  row.dataset.post = post.postId;
  row.dataset.postPosition = String(post.position);
  row.dataset.postHeld = "true";

  const author = document.createElement("div");
  author.className = "bl-post__author";
  author.textContent = post.authorName;

  const main = document.createElement("div");
  main.className = "bl-post__main";

  const meta = document.createElement("div");
  meta.className = "bl-post__meta";

  const time = document.createElement("span");
  time.className = "bl-muted";
  time.dataset.postTime = "true";
  time.textContent = post.createdAt;

  const badge = document.createElement("span");
  badge.className = "bl-badge bl-badge--danger";
  badge.dataset.postUnapproved = "true";
  badge.textContent = heldLabel();

  meta.append(time, badge);

  const body = document.createElement("div");
  body.className = "bl-post__body";
  body.dataset.postBody = "true";
  body.innerHTML = post.bodyHtml;

  main.append(meta, body);
  row.append(author, main);

  return row;
}

/** Held posts are inserted in position order among the visible blocks the page rendered. */
function insertHeldPosts(posts: readonly OverlayHeldPost[]): void {
  const page = document.querySelector("[data-topic-page]");

  if (page === null) {
    return;
  }

  let list = page.querySelector<HTMLElement>("[data-post-list]");

  if (list === null) {
    list = document.createElement("ol");
    list.className = "bl-post-list";
    list.dataset.postList = "true";
    const reply = page.querySelector("[data-reply-section]");
    page.insertBefore(list, reply);
  }

  page.querySelector<HTMLElement>("[data-topic-empty]")?.setAttribute("hidden", "");

  for (const post of [...posts].sort((left, right) => left.position - right.position)) {
    if (list.querySelector(`[data-post="${CSS.escape(post.postId)}"]`) !== null) {
      continue;
    }

    const block = heldPostBlock(post);
    const next = [...list.querySelectorAll<HTMLElement>("[data-post]")].find(
      (element) => Number(element.dataset.postPosition ?? "0") > post.position,
    );
    list.insertBefore(block, next ?? null);
  }
}

function heldTopicRow(topic: OverlayHeldTopic): HTMLElement {
  const row = document.createElement("li");
  row.className = "bl-topic-list__item";
  row.dataset.topicRow = topic.topicId;
  row.dataset.topicHeld = "true";

  const main = document.createElement("div");
  main.className = "bl-topic-row__main";

  const link = document.createElement("a");
  link.className = "bl-topic-list__title";
  link.href = topic.href;
  link.dataset.topicLink = topic.topicId;
  link.textContent = topic.title;

  const badge = document.createElement("span");
  badge.className = "bl-badge bl-badge--danger";
  badge.dataset.topicUnapproved = "true";
  badge.textContent = heldLabel();

  main.append(link, badge);
  row.append(main);

  return row;
}

function insertHeldTopics(topics: readonly OverlayHeldTopic[]): void {
  const content = document.querySelector("[data-forum-content]");

  if (content === null) {
    return;
  }

  let list = content.querySelector<HTMLElement>("[data-topic-list]");

  if (list === null) {
    list = document.createElement("ol");
    list.className = "bl-topic-list";
    list.dataset.topicList = "true";
    const subforums = content.querySelector("[data-subforums-block]");
    content.insertBefore(list, subforums);
  }

  content.querySelector<HTMLElement>("[data-topic-list-empty]")?.setAttribute("hidden", "");

  for (const topic of topics) {
    if (list.querySelector(`[data-topic-row="${CSS.escape(topic.topicId)}"]`) !== null) {
      continue;
    }

    list.append(heldTopicRow(topic));
  }
}

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

  setHeldPosts(posts) {
    insertHeldPosts(posts);
  },

  setHeldTopics(topics) {
    insertHeldTopics(topics);
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

  setBan(ban) {
    const notice = document.querySelector<HTMLElement>("[data-ban-notice]");

    if (notice === null) {
      return;
    }

    const until =
      ban.until === null
        ? ""
        : ` ${(notice.getAttribute("data-label-ban-until") ?? "").replace(
            "__DATE__",
            new Date(ban.until).toLocaleDateString(),
          )}`;
    const template = notice.getAttribute("data-label-ban") ?? "";
    notice.textContent = template.replace("__REASON__", ban.reason).replace("__UNTIL__", until);
    notice.hidden = false;
  },

  setIgnoredMembers(memberIds) {
    const ignored = new Set(memberIds);

    for (const post of document.querySelectorAll<HTMLElement>("[data-post][data-author]")) {
      const author = post.getAttribute("data-author") ?? "";

      if (!ignored.has(author)) {
        continue;
      }

      post.classList.add("bl-post--ignored");
      const notice = post.querySelector<HTMLElement>("[data-post-ignored]");

      if (notice !== null) {
        notice.hidden = false;
      }

      post.querySelector<HTMLButtonElement>("[data-post-reveal]")?.addEventListener(
        "click",
        () => {
          post.classList.remove("bl-post--ignored");

          if (notice !== null) {
            notice.hidden = true;
          }
        },
        { once: true },
      );
    }
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
