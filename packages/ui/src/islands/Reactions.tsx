import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FlagsProvider, useFlag } from "../flags.tsx";
import { subscribeReactionStates, viewerReactionState } from "./reactions/store.ts";

export interface ReactionOption {
  readonly id: string;
  readonly icon: string;
  readonly label: string;
  readonly count: number;
  readonly enabled: boolean;
}

export interface ReactionLabels {
  readonly bar: string;
  readonly pick: string;
  readonly remove: string;
  readonly whoReacted: string;
  readonly close: string;
  readonly loading: string;
  readonly empty: string;
  readonly failed: string;
  readonly deletedMember: string;
}

export interface ReactionsProps {
  readonly postId: string;
  readonly canReact: boolean;
  readonly reactions: readonly ReactionOption[];
  readonly labels: ReactionLabels;
  /** The render flag evaluated for this viewer, so the server HTML matches the client. */
  readonly flags: { readonly reactions: boolean };
}

interface ReactionMember {
  readonly id: string;
  readonly name: string | null;
}

interface ReactionsPayload {
  readonly ok?: boolean;
  readonly mine?: string | null;
  readonly summary?: Readonly<Record<string, number>>;
}

interface MembersPayload {
  readonly members?: readonly ReactionMember[];
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
 * The reaction bar island (reactions spec). Server-rendered totals stay usable without
 * JavaScript; this island adds picking, changing and removing, and the "who reacted" list.
 * The shared HTML never carries the member's own reaction (ADR 0006): that arrives from the
 * overlay through `subscribeReactionStates`.
 */
export function Reactions(props: ReactionsProps) {
  return (
    <FlagsProvider value={props.flags}>
      <ReactionsBody {...props} />
    </FlagsProvider>
  );
}

function ReactionsBody({ postId, canReact, reactions, labels }: ReactionsProps) {
  const enabled = useFlag("reactions");
  const viewer = useSyncExternalStore(
    subscribeReactionStates,
    () => viewerReactionState(postId),
    () => null,
  );
  const [counts, setCounts] = useState<Readonly<Record<string, number>>>(() =>
    Object.fromEntries(reactions.map((reaction) => [reaction.id, reaction.count])),
  );
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [members, setMembers] = useState<Readonly<Record<string, readonly ReactionMember[]>>>({});
  const [listOpen, setListOpen] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const visible = useMemo(
    () => reactions.filter((reaction) => reaction.enabled || (counts[reaction.id] ?? 0) > 0),
    [reactions, counts],
  );
  const mine = chosen === undefined ? (viewer?.reactionId ?? null) : chosen;
  const own = viewer?.own === true;
  const canPick = canReact && !own;
  const tally = visible.map((reaction) => `${reaction.id}:${counts[reaction.id] ?? 0}`).join(",");

  useEffect(() => {
    if (!listOpen) {
      return;
    }

    const element = dialog.current;

    if (element !== null && !element.open) {
      element.showModal();
    }
  }, [listOpen]);

  useEffect(() => {
    if (!listOpen) {
      return;
    }

    let active = true;
    const counted = tally === "" ? [] : tally.split(",");

    setListLoading(true);
    setListFailed(false);

    void Promise.all(
      counted
        .map((entry) => entry.split(":"))
        .filter(([, count]) => Number(count) > 0)
        .map(async ([reactionId]) => {
          try {
            const response = await fetch(
              `/api/posts/${postId}/reactions?reactionId=${reactionId ?? ""}`,
              { headers: { accept: "application/json" } },
            );

            if (!response.ok) {
              return [reactionId ?? "", null] as const;
            }

            const payload = (await response.json()) as MembersPayload;
            return [reactionId ?? "", payload.members ?? []] as const;
          } catch {
            return [reactionId ?? "", null] as const;
          }
        }),
    ).then((entries) => {
      if (!active) {
        return;
      }

      const next: Record<string, readonly ReactionMember[]> = {};
      let failedList = false;

      for (const [id, list] of entries) {
        if (list === null) {
          failedList = true;
        } else {
          next[id] = list;
        }
      }

      setMembers(next);
      setListFailed(failedList);
      setListLoading(false);
    });

    return () => {
      active = false;
    };
  }, [listOpen, postId, tally]);

  if (!enabled) {
    return null;
  }

  const pick = async (reactionId: string): Promise<void> => {
    if (!canPick || saving) {
      return;
    }

    const next = mine === reactionId ? null : reactionId;
    setSaving(true);
    setFailed(false);

    try {
      const token = await csrfToken();
      const response = await fetch(`/api/posts/${postId}/reactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bulletin-csrf": token ?? "",
        },
        body: JSON.stringify({ reactionId: next }),
      });

      if (!response.ok) {
        setFailed(true);
        return;
      }

      const payload = (await response.json()) as ReactionsPayload;
      setChosen(payload.mine ?? null);

      if (payload.summary !== undefined) {
        const summary = payload.summary;
        setCounts((current) => {
          const updated = { ...current };

          for (const reaction of reactions) {
            updated[reaction.id] = summary[reaction.id] ?? 0;
          }

          return updated;
        });
      }
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bl-reactions" data-reaction-bar={postId}>
      {visible.length === 0 ? (
        <p className="bl-muted">{labels.empty}</p>
      ) : (
        <fieldset className="bl-reactions__list">
          <legend className="bl-visually-hidden">{labels.bar}</legend>
          {visible.map((reaction) => {
            const count = counts[reaction.id] ?? 0;
            const selected = mine === reaction.id;
            // A staff-disabled reaction cannot be chosen, but the member must still be able to
            // take back the reaction they already gave.
            const interactive = canPick && (reaction.enabled || selected);

            return interactive ? (
              <button
                key={reaction.id}
                type="button"
                className="bl-reaction"
                data-reaction-pick={reaction.id}
                data-selected={selected ? "true" : "false"}
                aria-pressed={selected}
                aria-label={`${reaction.label}: ${count}`}
                title={selected ? labels.remove : labels.pick}
                disabled={saving}
                onClick={() => void pick(reaction.id)}
              >
                <span className="bl-reaction__icon" aria-hidden="true">
                  {reaction.icon}
                </span>
                <span className="bl-reaction__count" data-reaction-count={reaction.id}>
                  {count}
                </span>
              </button>
            ) : (
              <span
                key={reaction.id}
                className="bl-reaction bl-reaction--static"
                data-reaction-total={reaction.id}
                data-selected={selected ? "true" : "false"}
              >
                <span className="bl-visually-hidden">{reaction.label}</span>
                <span className="bl-reaction__icon" aria-hidden="true">
                  {reaction.icon}
                </span>
                <span className="bl-reaction__count" data-reaction-count={reaction.id}>
                  {count}
                </span>
              </span>
            );
          })}
        </fieldset>
      )}
      {visible.some((reaction) => (counts[reaction.id] ?? 0) > 0) ? (
        <button
          type="button"
          className="bl-button bl-button--quiet bl-button--small"
          data-reaction-who
          disabled={saving}
          onClick={() => setListOpen(true)}
        >
          {labels.whoReacted}
        </button>
      ) : null}
      {failed ? (
        <p className="bl-error-text" role="alert" data-reaction-error>
          {labels.failed}
        </p>
      ) : null}
      <dialog
        className="bl-dialog bl-reactions__dialog"
        ref={dialog}
        data-reaction-dialog
        onClose={() => setListOpen(false)}
      >
        <div className="bl-dialog__body">
          <div className="bl-dialog__header">
            <h2 className="bl-dialog__title">{labels.whoReacted}</h2>
            <button
              type="button"
              className="bl-button bl-button--quiet bl-button--small"
              onClick={() => dialog.current?.close()}
            >
              {labels.close}
            </button>
          </div>
          {listLoading ? <p className="bl-muted">{labels.loading}</p> : null}
          {listFailed ? (
            <p className="bl-error-text" role="alert">
              {labels.failed}
            </p>
          ) : null}
          {visible.map((reaction) => {
            const count = counts[reaction.id] ?? 0;

            if (count === 0) {
              return null;
            }

            const list = members[reaction.id] ?? [];

            return (
              <section
                key={reaction.id}
                className="bl-reactions__group"
                data-reaction-group={reaction.id}
              >
                <h3 className="bl-reactions__group-title">
                  <span aria-hidden="true">{reaction.icon}</span> {reaction.label}
                </h3>
                {list.length === 0 ? (
                  <p className="bl-muted">{labels.empty}</p>
                ) : (
                  <ul className="bl-reactions__members">
                    {list.map((member) => (
                      <li key={member.id}>{member.name ?? labels.deletedMember}</li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </dialog>
    </div>
  );
}
