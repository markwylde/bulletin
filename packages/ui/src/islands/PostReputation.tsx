import { useState, useSyncExternalStore } from "react";
import { subscribeReputationStates, viewerReputationState } from "./reputation/store.ts";

export interface ReputationLabels {
  readonly giveUp: string;
  readonly giveDown: string;
  readonly givenUp: string;
  readonly givenDown: string;
  readonly failed: string;
  readonly dailyLimit: string;
  readonly minPosts: string;
  readonly negativeNotAllowed: string;
  readonly cannotReceive: string;
  readonly alreadyGiven: string;
  readonly ownPost: string;
}

export interface PostReputationProps {
  readonly postId: string;
  readonly receiverId: string;
  readonly canGive: boolean;
  readonly canNegative: boolean;
  readonly locale: string;
  readonly labels: ReputationLabels;
}

interface GivePayload {
  readonly ok?: boolean;
  readonly code?: string;
  readonly total?: number;
  readonly resetsAt?: string;
  readonly minPosts?: number;
}

function message(payload: GivePayload, labels: ReputationLabels, locale: string): string {
  switch (payload.code) {
    case "daily_limit": {
      const time =
        payload.resetsAt === undefined
          ? ""
          : new Date(payload.resetsAt).toLocaleTimeString(locale, {
              hour: "2-digit",
              minute: "2-digit",
            });
      return labels.dailyLimit.replace("%s", time);
    }
    case "min_posts":
      return labels.minPosts.replace("%s", String(payload.minPosts ?? 0));
    case "negative_not_allowed":
      return labels.negativeNotAllowed;
    case "cannot_receive":
      return labels.cannotReceive;
    case "already_given":
      return labels.alreadyGiven;
    case "own_post":
      return labels.ownPost;
    default:
      return labels.failed;
  }
}

async function csrfToken(): Promise<string | null> {
  try {
    const response = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
    const body = (await response.json()) as { readonly csrfToken?: unknown };

    return typeof body.csrfToken === "string" ? body.csrfToken : null;
  } catch {
    return null;
  }
}

/**
 * Giving reputation from a post (reputation spec). The server renders the controls only for
 * members whose groups allow it; the personal overlay hides them on the member's own posts and
 * marks the vote already given (ADR 0006).
 */
export function PostReputation(props: PostReputationProps) {
  const { postId, receiverId, canGive, canNegative, locale, labels } = props;
  const viewer = useSyncExternalStore(
    subscribeReputationStates,
    () => viewerReputationState(postId),
    () => null,
  );
  const [chosen, setChosen] = useState<number | null | undefined>(undefined);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const given = chosen === undefined ? (viewer?.points ?? null) : chosen;

  if (!canGive || viewer?.own === true) {
    return null;
  }

  if (given !== null) {
    return (
      <span className="bl-post__reputation" data-reputation-given={given}>
        {given > 0 ? labels.givenUp : labels.givenDown}
      </span>
    );
  }

  const give = async (points: 1 | -1): Promise<void> => {
    if (saving !== null) {
      return;
    }

    setSaving(points);
    setError(null);

    try {
      const token = await csrfToken();
      const response = await fetch(`/api/posts/${postId}/reputation`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bulletin-csrf": token ?? "",
        },
        body: JSON.stringify({ points }),
      });
      const payload = (await response.json().catch(() => ({}))) as GivePayload;

      if (!response.ok) {
        setError(message(payload, labels, locale));
        return;
      }

      setChosen(points);

      if (payload.total !== undefined) {
        for (const element of document.querySelectorAll<HTMLElement>(
          `[data-reputation-count="${CSS.escape(receiverId)}"]`,
        )) {
          element.textContent = String(payload.total);
        }
      }
    } catch {
      setError(labels.failed);
    } finally {
      setSaving(null);
    }
  };

  return (
    <span className="bl-post__reputation">
      <button
        type="button"
        className="bl-button bl-button--quiet bl-button--small"
        data-reputation-vote="1"
        aria-label={labels.giveUp}
        disabled={saving !== null}
        onClick={() => void give(1)}
      >
        +1
      </button>
      {canNegative ? (
        <button
          type="button"
          className="bl-button bl-button--quiet bl-button--small"
          data-reputation-vote="-1"
          aria-label={labels.giveDown}
          disabled={saving !== null}
          onClick={() => void give(-1)}
        >
          −1
        </button>
      ) : null}
      {error === null ? null : (
        <span className="bl-error-text" role="alert" data-reputation-error>
          {error}
        </span>
      )}
    </span>
  );
}
