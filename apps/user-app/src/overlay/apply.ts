/**
 * The personal overlay payload (ADR 0006, task 6.3): read markers, notification counts and the
 * CSRF token for subsequent member writes. The applier is pure so the DOM adapter in
 * `visits.ts` is all that touches the document.
 */

export type OverlayCount = "notifications" | "conversations";

export interface OverlayPoll {
  readonly pollId: string;
  readonly hasVoted: boolean;
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
}

export interface UnreadSlot {
  markUnread(): void;
}

export interface CountSlot {
  setCount(count: number): void;
}

export interface OverlayTarget {
  unreadSlots(topicId: string): readonly UnreadSlot[];
  countSlots(count: OverlayCount): readonly CountSlot[];
  storeCsrfToken(token: string): void;
  hideAnnouncement(announcementId: string): void;
  setDraft(draft: OverlayDraft): void;
  setPollVoted(pollId: string, hasVoted: boolean): void;
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
