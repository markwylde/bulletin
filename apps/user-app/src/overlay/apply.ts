/**
 * The personal overlay payload (ADR 0006, task 6.3): read markers, notification counts and the
 * CSRF token for subsequent member writes. The applier is pure so the DOM adapter in
 * `visits.ts` is all that touches the document.
 */

import type { ReactionViewerState } from "@bulletin/ui/islands/reactions/store";
import type { ReputationViewerState } from "@bulletin/ui/islands/reputation/store";

export type OverlayCount = "notifications" | "conversations";

export interface OverlayEditablePost {
  readonly postId: string;
  readonly bodyMd?: string;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly canRedact: boolean;
  readonly canViewHistory: boolean;
}

export interface OverlayFirstUnread {
  readonly topicId: string;
  readonly url: string;
}

export interface OverlayPoll {
  readonly pollId: string;
  readonly hasVoted: boolean;
}

export interface OverlayHeldPost {
  readonly postId: string;
  readonly topicId: string;
  readonly position: number;
  readonly authorName: string;
  readonly bodyHtml: string;
  readonly createdAt: string;
  readonly href: string;
}

export interface OverlayHeldTopic {
  readonly topicId: string;
  readonly title: string;
  readonly href: string;
  readonly createdAt: string;
  readonly reason: string | null;
}

export interface OverlayDraft {
  readonly contextKey: string;
  readonly bodyMd: string;
  readonly updatedAt: string;
}

export interface OverlayPayload {
  readonly unread?: readonly string[];
  readonly counts?: Partial<Record<OverlayCount, number>>;
  readonly csrfToken?: string;
  /** Announcement ids the member dismissed at their current content version. */
  readonly dismissedAnnouncements?: readonly string[];
  /** The member's draft for the editor on this page, never in shared HTML (ADR 0007). */
  readonly draft?: OverlayDraft;
  /** Whether the member already voted in the poll on this page (task 4.2). */
  readonly polls?: readonly OverlayPoll[];
  /** Forums with at least one unread topic for this member (task 5.1). */
  readonly unreadForums?: readonly string[];
  /** First unread post links for topic rows on this page (task 5.1). */
  readonly firstUnread?: readonly OverlayFirstUnread[];
  /** Ownership-dependent post controls and raw Markdown (reviewer finding 5). */
  readonly editablePosts?: readonly OverlayEditablePost[];
  /** The viewer's own held posts for the topic page, rendered server-side (ADR 0005/0006). */
  readonly heldPosts?: readonly OverlayHeldPost[];
  /** The viewer's own held topics for the forum list, rendered client-side. */
  readonly heldTopics?: readonly OverlayHeldTopic[];
  /** Follow state for every follow target the page rendered, e.g. `topic:12`. */
  readonly follows?: Readonly<Record<string, boolean>>;
  /** The member's own reaction on each rendered post; never in shared HTML (ADR 0006). */
  readonly reactions?: readonly ReactionViewerState[];
  /** The member's own reputation vote on each rendered post. */
  readonly reputation?: readonly ReputationViewerState[];
  /** The member hides every signature under posts; applied client-side only (task 2.1). */
  readonly hideSignatures?: boolean;
  /** Member ids the viewer ignores; their rendered posts collapse client-side (task 3.1). */
  readonly ignored?: readonly string[];
  /** An active member ban, shown in the shell with its reason and end date. */
  readonly ban?: { readonly reason: string; readonly until: string | null };
}

export interface UnreadSlot {
  markUnread(): void;
}

export interface CountSlot {
  setCount(count: number): void;
}

export interface OverlayTarget {
  unreadSlots(topicId: string): readonly UnreadSlot[];
  forumUnreadSlots(forumId: string): readonly UnreadSlot[];
  countSlots(count: OverlayCount): readonly CountSlot[];
  storeCsrfToken(token: string): void;
  hideAnnouncement(announcementId: string): void;
  setDraft(draft: OverlayDraft): void;
  setPollVoted(pollId: string, hasVoted: boolean): void;
  setFirstUnread(topicId: string, url: string): void;
  setEditablePosts(posts: readonly OverlayEditablePost[]): void;
  setHeldPosts(posts: readonly OverlayHeldPost[]): void;
  setHeldTopics(topics: readonly OverlayHeldTopic[]): void;
  setFollow(context: string, following: boolean): void;
  setReactions(states: readonly ReactionViewerState[]): void;
  setReputation(states: readonly ReputationViewerState[]): void;
  setHideSignatures(hidden: boolean): void;
  setIgnoredMembers(memberIds: readonly string[]): void;
  setBan(ban: { readonly reason: string; readonly until: string | null }): void;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Applies a member's overlay to the cached page. Counts below zero or non-numbers are ignored,
 * and the token is only stored when the server actually issued one.
 */
export function applyOverlay(target: OverlayTarget, payload: OverlayPayload): void {
  for (const topicId of payload.unread ?? []) {
    if (typeof topicId !== "string") {
      continue;
    }

    for (const slot of target.unreadSlots(topicId)) {
      slot.markUnread();
    }
  }

  for (const forumId of payload.unreadForums ?? []) {
    if (typeof forumId !== "string" || !/^[1-9]\d{0,18}$/.test(forumId)) {
      continue;
    }

    for (const slot of target.forumUnreadSlots(forumId)) {
      slot.markUnread();
    }
  }

  for (const link of payload.firstUnread ?? []) {
    if (
      typeof link === "object" &&
      link !== null &&
      typeof link.topicId === "string" &&
      /^[1-9]\d{0,18}$/.test(link.topicId) &&
      typeof link.url === "string" &&
      /^\/topic\/\d+-/.test(link.url)
    ) {
      target.setFirstUnread(link.topicId, link.url);
    }
  }

  if (payload.ban !== undefined && typeof payload.ban.reason === "string") {
    target.setBan({ reason: payload.ban.reason, until: payload.ban.until ?? null });
  }

  if (payload.editablePosts !== undefined) {
    target.setEditablePosts(payload.editablePosts);
  }

  const heldPosts = (payload.heldPosts ?? []).flatMap((post) => {
    if (
      typeof post !== "object" ||
      post === null ||
      typeof post.postId !== "string" ||
      !/^[1-9]\d{0,18}$/.test(post.postId) ||
      typeof post.topicId !== "string" ||
      !/^[1-9]\d{0,18}$/.test(post.topicId) ||
      typeof post.position !== "number" ||
      !Number.isFinite(post.position) ||
      typeof post.bodyHtml !== "string"
    ) {
      return [];
    }

    return [post];
  });

  if (heldPosts.length > 0) {
    target.setHeldPosts(heldPosts);
  }

  const heldTopics = (payload.heldTopics ?? []).flatMap((topic) => {
    if (
      typeof topic !== "object" ||
      topic === null ||
      typeof topic.topicId !== "string" ||
      !/^[1-9]\d{0,18}$/.test(topic.topicId) ||
      typeof topic.title !== "string" ||
      typeof topic.href !== "string" ||
      !/^\/topic\/\d+-/.test(topic.href)
    ) {
      return [];
    }

    return [topic];
  });

  if (heldTopics.length > 0) {
    target.setHeldTopics(heldTopics);
  }

  const counts = payload.counts ?? {};

  for (const name of ["notifications", "conversations"] as const) {
    const count = counts[name];

    if (!isCount(count)) {
      continue;
    }

    for (const slot of target.countSlots(name)) {
      slot.setCount(Math.max(0, Math.trunc(count)));
    }
  }

  if (typeof payload.csrfToken === "string" && payload.csrfToken !== "") {
    target.storeCsrfToken(payload.csrfToken);
  }

  for (const announcementId of payload.dismissedAnnouncements ?? []) {
    if (typeof announcementId === "string" && /^[1-9]\d{0,18}$/.test(announcementId)) {
      target.hideAnnouncement(announcementId);
    }
  }

  for (const poll of payload.polls ?? []) {
    if (
      typeof poll === "object" &&
      poll !== null &&
      typeof poll.pollId === "string" &&
      /^[1-9]\d{0,18}$/.test(poll.pollId) &&
      typeof poll.hasVoted === "boolean"
    ) {
      target.setPollVoted(poll.pollId, poll.hasVoted);
    }
  }

  for (const [context, following] of Object.entries(payload.follows ?? {})) {
    if (/^(topic|forum|member):[1-9]\d{0,18}$/.test(context) && typeof following === "boolean") {
      target.setFollow(context, following);
    }
  }

  const reactions = (payload.reactions ?? []).flatMap((state) => {
    if (
      typeof state !== "object" ||
      state === null ||
      typeof state.postId !== "string" ||
      !/^[1-9]\d{0,18}$/.test(state.postId) ||
      typeof state.own !== "boolean" ||
      !(
        state.reactionId === null ||
        (typeof state.reactionId === "string" && /^[1-9]\d{0,18}$/.test(state.reactionId))
      )
    ) {
      return [];
    }

    return [{ postId: state.postId, reactionId: state.reactionId, own: state.own }];
  });

  target.setReactions(reactions);

  const reputation = (payload.reputation ?? []).flatMap((state) => {
    if (
      typeof state !== "object" ||
      state === null ||
      typeof state.postId !== "string" ||
      !/^[1-9]\d{0,18}$/.test(state.postId) ||
      typeof state.own !== "boolean" ||
      !(state.points === null || state.points === 1 || state.points === -1)
    ) {
      return [];
    }

    return [{ postId: state.postId, points: state.points, own: state.own }];
  });

  target.setReputation(reputation);
  target.setHideSignatures(payload.hideSignatures === true);
  target.setIgnoredMembers(
    (payload.ignored ?? []).filter(
      (id): id is string => typeof id === "string" && /^[1-9]\d{0,18}$/.test(id),
    ),
  );

  const draft = payload.draft;

  if (
    typeof draft === "object" &&
    draft !== null &&
    typeof draft.contextKey === "string" &&
    typeof draft.bodyMd === "string" &&
    typeof draft.updatedAt === "string"
  ) {
    target.setDraft(draft);
  }
}
