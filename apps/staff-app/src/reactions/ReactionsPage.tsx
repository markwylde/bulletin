import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface ReactionView {
  readonly id: string;
  readonly key: string;
  readonly icon: string;
  readonly labelKey: string;
  readonly weight: -1 | 0 | 1;
  readonly position: number;
  readonly enabled: boolean;
}

interface ReactionsView {
  readonly reactions: readonly ReactionView[];
}

/** The shipped reaction labels; the server validates the same list (ADR 0013). */
const LABEL_KEYS = [
  "reaction.label.like",
  "reaction.label.thanks",
  "reaction.label.love",
  "reaction.label.laugh",
  "reaction.label.wow",
  "reaction.label.sad",
  "reaction.label.confused",
  "reaction.label.angry",
] as const;

const WEIGHTS = [-1, 0, 1] as const;

interface Draft {
  readonly id: string | null;
  readonly key: string;
  readonly icon: string;
  readonly labelKey: string;
  readonly weight: -1 | 0 | 1;
  readonly position: string;
  readonly enabled: boolean;
}

const EMPTY: Draft = {
  id: null,
  key: "",
  icon: "",
  labelKey: LABEL_KEYS[0],
  weight: 0,
  position: "0",
  enabled: true,
};

function parseWeight(value: string): -1 | 0 | 1 {
  const parsed = Number(value);
  return parsed === -1 || parsed === 1 ? parsed : 0;
}

export function ReactionsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const query = useQuery({
    queryKey: ["staff", "reactions"],
    queryFn: () => apiGet<ReactionsView>("/api/staff/reactions"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/reactions", body),
    onSuccess: (_data, body) => {
      toast.pushToast({ messageKey: "staff.reactions.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "reactions"] });

      if (body.action === "save") {
        setDraft(EMPTY);
      }
    },
    onError: (error: unknown, body) => {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "duplicate_key") {
        toast.pushToast({ messageKey: "staff.reactions.duplicate", tone: "error" });
      } else if (code === "in_use") {
        toast.pushToast({ messageKey: "staff.reactions.inUse", tone: "error" });
      } else if (code === "invalid") {
        toast.pushToast({ messageKey: "staff.reactions.invalid", tone: "error" });
      } else {
        toast.pushToast({ messageKey: "staff.reactions.saveError", tone: "error" });
      }

      if (body.action === "delete" && code === "in_use") {
        void queryClient.invalidateQueries({ queryKey: ["staff", "reactions"] });
      }
    },
  });

  const selectReaction = (reaction: ReactionView): void => {
    setDraft({
      id: reaction.id,
      key: reaction.key,
      icon: reaction.icon,
      labelKey: reaction.labelKey,
      weight: reaction.weight,
      position: String(reaction.position),
      enabled: reaction.enabled,
    });
  };

  const canSave =
    draft.key.trim() !== "" &&
    draft.icon.trim() !== "" &&
    Number.isInteger(Number(draft.position)) &&
    Number(draft.position) >= 0;

  return (
    <div className="page" data-page="reactions">
      <header className="page-header">
        <h1>{t("staff.reactions.title")}</h1>
        <p>{t("staff.reactions.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.reactions.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <>
          <section className="admin-panel" aria-labelledby="reactions-list-title">
            <h2 id="reactions-list-title">{t("staff.reactions.list.title")}</h2>
            <div className="matrix-scroll" data-matrix-scroll>
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th scope="col">{t("staff.reactions.order")}</th>
                    <th scope="col">{t("staff.reactions.icon")}</th>
                    <th scope="col">{t("staff.reactions.label")}</th>
                    <th scope="col">{t("staff.reactions.key")}</th>
                    <th scope="col">{t("staff.reactions.weight")}</th>
                    <th scope="col">{t("staff.reactions.enabled")}</th>
                    <th scope="col">{t("staff.reactions.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.reactions.map((reaction, index) => (
                    <tr key={reaction.id} data-reaction-row={reaction.id}>
                      <td data-label={t("staff.reactions.order")}>{reaction.position}</td>
                      <td data-label={t("staff.reactions.icon")}>
                        <span aria-hidden="true">{reaction.icon}</span>
                      </td>
                      <td data-label={t("staff.reactions.label")}>{t(reaction.labelKey)}</td>
                      <td data-label={t("staff.reactions.key")}>{reaction.key}</td>
                      <td data-label={t("staff.reactions.weight")}>{reaction.weight}</td>
                      <td data-label={t("staff.reactions.enabled")}>
                        {reaction.enabled
                          ? t("staff.reactions.enabled.yes")
                          : t("staff.reactions.enabled.no")}
                      </td>
                      <td data-label={t("staff.reactions.actions")}>
                        <button
                          type="button"
                          data-reaction-edit={reaction.id}
                          onClick={() => selectReaction(reaction)}
                        >
                          {t("staff.reactions.edit")}
                        </button>
                        <button
                          type="button"
                          data-reaction-move={reaction.id}
                          data-direction="up"
                          disabled={mutate.isPending || index === 0}
                          onClick={() =>
                            mutate.mutate({ action: "move", id: reaction.id, direction: "up" })
                          }
                        >
                          {t("staff.reactions.moveUp")}
                        </button>
                        <button
                          type="button"
                          data-reaction-move={reaction.id}
                          data-direction="down"
                          disabled={mutate.isPending || index === query.data.reactions.length - 1}
                          onClick={() =>
                            mutate.mutate({ action: "move", id: reaction.id, direction: "down" })
                          }
                        >
                          {t("staff.reactions.moveDown")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              data-reaction-new
              onClick={() =>
                setDraft({
                  ...EMPTY,
                  position: String(query.data.reactions.length),
                })
              }
            >
              {t("staff.reactions.new")}
            </button>
          </section>

          <section className="admin-panel" data-reaction-editor>
            <h2>{t("staff.reactions.editor.title")}</h2>
            <p className="widget-muted">{t("staff.reactions.hint")}</p>
            <div className="admin-form">
              <label>
                <span>{t("staff.reactions.key")}</span>
                <input
                  data-reaction-key
                  value={draft.key}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, key: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.reactions.icon")}</span>
                <input
                  data-reaction-icon
                  maxLength={32}
                  value={draft.icon}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, icon: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.reactions.label")}</span>
                <select
                  data-reaction-label
                  value={draft.labelKey}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, labelKey: event.target.value }))
                  }
                >
                  {LABEL_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {t(key)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("staff.reactions.weight")}</span>
                <select
                  data-reaction-weight
                  value={String(draft.weight)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      weight: parseWeight(event.target.value),
                    }))
                  }
                >
                  {WEIGHTS.map((weight) => (
                    <option key={weight} value={String(weight)}>
                      {weight > 0 ? "+1" : String(weight)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("staff.reactions.order")}</span>
                <input
                  type="number"
                  min={0}
                  data-reaction-position
                  value={draft.position}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, position: event.target.value }))
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  data-reaction-enabled
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                <span>{t("staff.reactions.enabled")}</span>
              </label>
            </div>

            <div className="admin-form">
              <button
                type="button"
                data-reaction-save
                disabled={mutate.isPending || !canSave}
                onClick={() =>
                  mutate.mutate({
                    action: "save",
                    reaction: {
                      ...(draft.id === null ? {} : { id: draft.id }),
                      key: draft.key,
                      icon: draft.icon,
                      labelKey: draft.labelKey,
                      weight: draft.weight,
                      position: Number(draft.position),
                      enabled: draft.enabled,
                    },
                  })
                }
              >
                {t("staff.reactions.save")}
              </button>
              <button
                type="button"
                data-reaction-delete
                disabled={mutate.isPending || draft.id === null}
                onClick={() => setConfirmDelete(true)}
              >
                {t("staff.reactions.delete")}
              </button>
            </div>
            <ConfirmDialog
              open={confirmDelete}
              titleKey="staff.reactions.deleteTitle"
              bodyKey="staff.reactions.deleteBody"
              confirmLabelKey="staff.reactions.delete"
              tone="danger"
              busy={mutate.isPending}
              onConfirm={() => {
                setConfirmDelete(false);

                if (draft.id !== null) {
                  mutate.mutate({ action: "delete", id: draft.id });
                }
              }}
              onCancel={() => setConfirmDelete(false)}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}
