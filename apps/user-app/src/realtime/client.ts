import { CSRF_STORAGE_KEY } from "@bulletin/domain/auth/browser";
import {
  STREAM_CONTROL_EVENTS,
  STREAM_EVENT_NAMES,
  type StreamNewRepliesPayload,
  type StreamNotificationPayload,
} from "@bulletin/domain/events/stream";

const ID = /^[1-9]\d{0,18}$/;

function setCount(name: "notifications", count: number): void {
  for (const slot of document.querySelectorAll<HTMLElement>(`[data-overlay-count="${name}"]`)) {
    slot.textContent = String(Math.max(0, count));
    slot.hidden = count <= 0;
  }
}

function lastRenderedPostId(): string | null {
  const posts = [...document.querySelectorAll<HTMLElement>("[data-post]")];
  const last = posts[posts.length - 1]?.getAttribute("data-post") ?? null;
  return last !== null && ID.test(last) ? last : null;
}

function streamUrl(): string {
  const topicPage = document.querySelector<HTMLElement>("[data-topic-page]");
  const topicId = topicPage?.getAttribute("data-topic-id") ?? null;
  // The banner only makes sense on the last page: a later page has its own "next" link.
  const onLastPage = document.querySelector("[data-page-next]") === null;
  const params = new URLSearchParams();

  if (topicId !== null && ID.test(topicId) && onLastPage) {
    params.set("topic", topicId);
    const postId = lastRenderedPostId();

    if (postId !== null) {
      params.set("post", postId);
    }
  }

  const query = params.toString();
  return query === "" ? "/api/stream" : `/api/stream?${query}`;
}

function showNewReplies(payload: StreamNewRepliesPayload): void {
  const banner = document.querySelector<HTMLButtonElement>("[data-new-replies]");

  if (banner === null || payload.count <= 0) {
    return;
  }

  const previous = Number(banner.dataset.count ?? "0");
  const count = (Number.isFinite(previous) && previous > 0 ? previous : 0) + payload.count;
  const suffix =
    count === 1
      ? (banner.getAttribute("data-label-one") ?? "new reply")
      : (banner.getAttribute("data-label-other") ?? "new replies");
  banner.textContent = `${count} ${suffix}`;
  banner.dataset.count = String(count);
  banner.dataset.lastPostId = payload.postId;
  banner.hidden = false;

  if (banner.dataset.bound !== "true") {
    banner.dataset.bound = "true";
    banner.addEventListener("click", () => {
      const topicId = document.querySelector("[data-topic-page]")?.getAttribute("data-topic-id");
      const postId = banner.dataset.lastPostId;

      activeStream?.close();
      // The permalink redirects to the right page, so a reply that started a new page loads too.
      if (
        topicId !== null &&
        topicId !== undefined &&
        postId !== undefined &&
        ID.test(topicId) &&
        ID.test(postId)
      ) {
        window.location.assign(`/topic/${topicId}/post/${postId}`);
        return;
      }

      window.location.reload();
    });
  }
}

async function refreshCounts(): Promise<void> {
  const ctx =
    document.querySelector("[data-overlay-ctx]")?.getAttribute("data-overlay-ctx") ?? "board";

  try {
    const response = await fetch("/api/me/overlay", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bulletin-overlay": "1" },
      body: JSON.stringify({ ctx }),
    });

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as {
      readonly counts?: { readonly notifications?: number };
    };
    setCount("notifications", payload.counts?.notifications ?? 0);
  } catch {
    // The next reconnect or overlay request refreshes them.
  }
}

function showReauthPrompt(): void {
  // Editors keep unsaved text locally before the grace window makes draft autosave fail.
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

function reloadLoggedOut(): void {
  try {
    sessionStorage.removeItem(CSRF_STORAGE_KEY);
  } catch {
    // Private mode.
  }

  window.location.reload();
}

let activeStream: EventSource | null = null;

if (
  document.documentElement.dataset.visitor === "member" &&
  document.querySelector("[data-realtime]") !== null
) {
  const source = new EventSource(streamUrl());
  activeStream = source;

  window.addEventListener("pagehide", () => {
    activeStream?.close();
    activeStream = null;
  });

  source.addEventListener("open", () => {
    document.documentElement.dataset.stream = "open";
  });

  source.addEventListener(STREAM_EVENT_NAMES.notifications, (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as StreamNotificationPayload;
      setCount("notifications", payload.count);
    } catch {
      // Ignore malformed payloads.
    }
  });

  source.addEventListener(STREAM_EVENT_NAMES.newReplies, (event) => {
    try {
      showNewReplies(JSON.parse((event as MessageEvent<string>).data) as StreamNewRepliesPayload);
    } catch {
      // Ignore malformed payloads.
    }
  });

  source.addEventListener(STREAM_CONTROL_EVENTS[0], () => {
    void refreshCounts();
  });

  source.addEventListener(STREAM_CONTROL_EVENTS[1], () => {
    source.close();
    activeStream = null;
    document.documentElement.dataset.stream = "revoked";
    reloadLoggedOut();
  });

  source.addEventListener(STREAM_CONTROL_EVENTS[2], () => {
    source.close();
    activeStream = null;
    document.documentElement.dataset.stream = "reauth";
    showReauthPrompt();
  });
}
