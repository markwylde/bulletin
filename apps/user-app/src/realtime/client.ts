import { CSRF_STORAGE_KEY } from "@bulletin/domain/auth/browser";
import {
  STREAM_CONTROL_EVENTS,
  STREAM_EVENT_NAMES,
  type StreamConversationRepliesPayload,
  type StreamNewRepliesPayload,
  type StreamNotificationPayload,
} from "@bulletin/domain/events/stream";
import { clearReauthDrafts } from "@bulletin/ui/islands/editor/drafts";
import { clientCsrfToken } from "../csrf.ts";

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

function lastConversationMessageId(): string | null {
  const messages = [...document.querySelectorAll<HTMLElement>("[data-conversation-message]")];
  const last = messages[messages.length - 1]?.getAttribute("data-conversation-message") ?? null;
  return last !== null && ID.test(last) ? last : null;
}

function streamUrl(): string {
  const conversationPage = document.querySelector<HTMLElement>("[data-conversation-page]");
  const conversationId = conversationPage?.getAttribute("data-conversation-id") ?? null;
  const topicPage = document.querySelector<HTMLElement>("[data-topic-page]");
  const topicId = topicPage?.getAttribute("data-topic-id") ?? null;
  // The banner only makes sense on the last page: a later page has its own "next" link.
  const onLastPage = document.querySelector("[data-page-next]") === null;
  const params = new URLSearchParams();

  if (conversationId !== null && ID.test(conversationId)) {
    params.set("conversation", conversationId);
    const messageId = lastConversationMessageId();

    if (messageId !== null) {
      params.set("message", messageId);
    }
  } else if (topicId !== null && ID.test(topicId) && onLastPage) {
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

interface LiveConversationMessage {
  readonly id: string;
  readonly authorId: string;
  readonly authorName: string | null;
  readonly bodyHtml: string;
  readonly createdAt: string;
}

function appendConversationMessage(list: HTMLElement, message: LiveConversationMessage): void {
  const item = document.createElement("li");
  item.className = "bl-message";
  item.dataset.conversationMessage = message.id;

  const header = document.createElement("header");
  header.className = "bl-message__header";
  const author = document.createElement("a");
  author.href = `/profile/${message.authorId}`;
  author.dataset.conversationAuthor = "true";
  author.textContent = message.authorName ?? "";
  const time = document.createElement("time");
  time.className = "bl-muted";
  time.dateTime = message.createdAt;
  time.textContent = new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(message.createdAt));
  header.append(author, time);

  const body = document.createElement("div");
  body.className = "bl-message__body";
  // The server sanitised this HTML in the content pipeline (ADR 0007).
  body.innerHTML = message.bodyHtml;
  item.append(header, body);
  list.append(item);
}

async function appendConversationReplies(payload: StreamConversationRepliesPayload): Promise<void> {
  const page = document.querySelector<HTMLElement>("[data-conversation-page]");
  const conversationId = page?.getAttribute("data-conversation-id") ?? "";

  if (page === null || conversationId !== payload.conversationId) {
    return;
  }

  const list = page.querySelector<HTMLElement>("[data-conversation-messages]");
  const last = lastConversationMessageId() ?? "0";

  if (list === null) {
    return;
  }

  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?after=${encodeURIComponent(last)}`,
    { headers: { accept: "application/json" } },
  );

  if (!response.ok) {
    return;
  }

  const body = (await response.json()) as { messages?: readonly LiveConversationMessage[] };

  for (const message of body.messages ?? []) {
    if (
      !ID.test(message.id) ||
      document.querySelector(`[data-conversation-message="${message.id}"]`) !== null
    ) {
      continue;
    }

    appendConversationMessage(list, message);
  }

  const csrf = await clientCsrfToken();
  await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/read`, {
    method: "POST",
    headers: {
      accept: "application/json",
      ...(csrf === null ? {} : { "x-bulletin-csrf": csrf }),
    },
  }).catch(() => undefined);
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

  // A revoked session clears member-scoped local drafts (ADR 0014).
  clearReauthDrafts();
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

  source.addEventListener(STREAM_EVENT_NAMES.conversationReplies, (event) => {
    try {
      void appendConversationReplies(
        JSON.parse((event as MessageEvent<string>).data) as StreamConversationRepliesPayload,
      );
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
