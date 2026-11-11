/**
 * The member's own reaction state for cached reaction bars (ADR 0006). The overlay publishes
 * it once; islands hydrate later and read the latest snapshot, so the order of the two never
 * loses the viewer's state.
 */
export interface ReactionViewerState {
  readonly postId: string;
  readonly reactionId: string | null;
  /** The viewer wrote the post, so the bar shows totals only (members cannot self-react). */
  readonly own: boolean;
}

type Listener = (states: readonly ReactionViewerState[]) => void;

let latest: readonly ReactionViewerState[] = [];
const listeners = new Set<Listener>();

export function publishReactionStates(states: readonly ReactionViewerState[]): void {
  latest = states;

  for (const listener of listeners) {
    listener(states);
  }
}

/** Subscribes and immediately receives the current snapshot (`useSyncExternalStore` shape). */
export function subscribeReactionStates(listener: Listener): () => void {
  listeners.add(listener);
  listener(latest);

  return () => {
    listeners.delete(listener);
  };
}

export function viewerReactionState(postId: string): ReactionViewerState | null {
  return latest.find((state) => state.postId === postId) ?? null;
}
