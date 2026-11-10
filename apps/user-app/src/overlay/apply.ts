/**
 * The personal overlay payload (ADR 0006, task 6.3): read markers, notification counts and the
 * CSRF token for subsequent member writes. The applier is pure so the DOM adapter in
 * `visits.ts` is all that touches the document.
 */

export type OverlayCount = "notifications" | "conversations";

export interface OverlayPayload {
  readonly unread?: readonly string[];
  readonly counts?: Partial<Record<OverlayCount, number>>;
  readonly csrfToken?: string;
  /** Announcement ids the member dismissed at their current content version. */
  readonly dismissedAnnouncements?: readonly string[];
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
}
