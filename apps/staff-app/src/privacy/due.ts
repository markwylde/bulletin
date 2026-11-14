const DUE_SOON_MS = 5 * 24 * 60 * 60 * 1_000;

export type RequestDueState = "overdue" | "soon" | "later";

/** A pending request is due soon from day 25 of its 30-day window. */
export function requestDueState(
  dueAt: string | Date,
  status: string,
  now: number = Date.now(),
): RequestDueState {
  if (status !== "pending" && status !== "processing") {
    return "later";
  }

  const due = dueAt instanceof Date ? dueAt.getTime() : new Date(dueAt).getTime();

  if (!Number.isFinite(due)) {
    return "later";
  }

  if (due <= now) {
    return "overdue";
  }

  return due - now <= DUE_SOON_MS ? "soon" : "later";
}
