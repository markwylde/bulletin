/**
 * The member's own reputation vote per post (ADR 0006). Published by the overlay; the island
 * reads the latest snapshot even if it hydrates after the overlay request.
 */
export interface ReputationViewerState {
  readonly postId: string;
  /** `1`, `-1`, or null when the member has not voted on the post. */
  readonly points: number | null;
  /** The viewer wrote the post; giving reputation to it is refused. */
  readonly own: boolean;
}

type Listener = (states: readonly ReputationViewerState[]) => void;

let latest: readonly ReputationViewerState[] = [];
const listeners = new Set<Listener>();

export function publishReputationStates(states: readonly ReputationViewerState[]): void {
  latest = states;

  for (const listener of listeners) {
    listener(states);
  }
}

export function subscribeReputationStates(listener: Listener): () => void {
  listeners.add(listener);
  listener(latest);

  return () => {
    listeners.delete(listener);
  };
}

export function viewerReputationState(postId: string): ReputationViewerState | null {
  return latest.find((state) => state.postId === postId) ?? null;
}
