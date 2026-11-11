import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface BadgeRuleView {
  readonly type: string;
  readonly threshold: number;
  readonly forumId: string | null;
}

interface BadgeView {
  readonly id: string;
  readonly key: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly descriptionLabels: Readonly<Record<string, string>>;
  readonly imageKey: string | null;
  readonly position: number;
  readonly rule: BadgeRuleView | null;
}

interface BadgeDraft {
  readonly id: string | null;
  readonly key: string;
  readonly en: string;
  readonly es: string;
  readonly fr: string;
  readonly descEn: string;
  readonly descEs: string;
  readonly descFr: string;
  readonly imageKey: string;
  readonly position: number;
  readonly ruleType: string;
  readonly threshold: number;
  readonly forumId: string;
}

const RULE_TYPES = [
  "post_count",
  "reputation",
  "days_joined",
  "reactions_received",
  "topics_started",
  "posts_in_forum",
] as const;

const EMPTY: BadgeDraft = {
  id: null,
  key: "",
  en: "",
  es: "",
  fr: "",
  descEn: "",
  descEs: "",
  descFr: "",
  imageKey: "",
  position: 0,
  ruleType: "",
  threshold: 0,
  forumId: "",
};

function RuleLabel({ type }: { readonly type: string }) {
  const t = useT();

  switch (type) {
    case "post_count":
      return <>{t("staff.badges.rule.postCount")}</>;
    case "reputation":
      return <>{t("staff.badges.rule.reputation")}</>;
    case "days_joined":
      return <>{t("staff.badges.rule.daysJoined")}</>;
    case "reactions_received":
      return <>{t("staff.badges.rule.reactionsReceived")}</>;
    case "topics_started":
      return <>{t("staff.badges.rule.topicsStarted")}</>;
    case "posts_in_forum":
      return <>{t("staff.badges.rule.postsInForum")}</>;
    default:
      return <>{t("staff.badges.manual")}</>;
  }
}

export function BadgesPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BadgeDraft>(EMPTY);
  const [editing, setEditing] = useState(false);
  const query = useQuery({
    queryKey: ["staff", "badges"],
    queryFn: () => apiGet<{ badges: readonly BadgeView[] }>("/api/staff/badges"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/badges", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.badges.saved", tone: "success" });
      setEditing(false);
      setDraft(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ["staff", "badges"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.badges.saveError", tone: "error" }),
  });

  const save = (): void => {
    const automatic = draft.ruleType !== "";

    if (
      !/^[a-z][a-z0-9_-]{0,31}$/.test(draft.key) ||
      draft.en.trim() === "" ||
      draft.es.trim() === "" ||
      draft.fr.trim() === "" ||
      draft.descEn.trim() === "" ||
      draft.descEs.trim() === "" ||
      draft.descFr.trim() === "" ||
      (automatic &&
        (draft.threshold < 0 || (draft.ruleType === "posts_in_forum" && draft.forumId === "")))
    ) {
      toast.pushToast({ messageKey: "staff.badges.invalid", tone: "error" });
      return;
    }

    mutate.mutate({
      action: "save",
      badge: {
        ...(draft.id === null ? {} : { id: draft.id }),
        key: draft.key,
        labels: { en: draft.en, es: draft.es, fr: draft.fr },
        descriptionLabels: { en: draft.descEn, es: draft.descEs, fr: draft.descFr },
        imageKey: draft.imageKey.trim(),
        position: draft.position,
        rule: automatic
          ? {
              type: draft.ruleType,
              threshold: draft.threshold,
              forumId: draft.ruleType === "posts_in_forum" ? draft.forumId : "",
            }
          : null,
      },
    });
  };

  return (
    <div className="page" data-page="badges">
      <header className="page-header">
        <h1>{t("staff.badges.title")}</h1>
        <p>{t("staff.badges.intro")}</p>
      </header>
      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.badges.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}
      {query.isSuccess ? (
        <>
          <section className="admin-panel">
            <div className="admin-form">
              <button
                type="button"
                data-badge-new
                onClick={() => {
                  setDraft(EMPTY);
                  setEditing(true);
                }}
              >
                {t("staff.badges.add")}
              </button>
            </div>
            {query.data.badges.length === 0 ? (
              <p className="widget-muted">{t("staff.badges.empty")}</p>
            ) : (
              <ul className="badge-list" data-badge-list>
                {query.data.badges.map((badge) => (
                  <li className="badge-row" key={badge.id} data-badge={badge.id}>
                    <strong>{badge.labels.en ?? ""}</strong>{" "}
                    <span className="widget-muted">
                      {badge.rule === null ? (
                        t("staff.badges.manual")
                      ) : (
                        <>
                          <RuleLabel type={badge.rule.type} /> · {badge.rule.threshold}
                        </>
                      )}
                    </span>
                    <div className="admin-form">
                      <button
                        type="button"
                        data-badge-edit={badge.id}
                        onClick={() => {
                          setDraft({
                            id: badge.id,
                            key: badge.key,
                            en: badge.labels.en ?? "",
                            es: badge.labels.es ?? "",
                            fr: badge.labels.fr ?? "",
                            descEn: badge.descriptionLabels.en ?? "",
                            descEs: badge.descriptionLabels.es ?? "",
                            descFr: badge.descriptionLabels.fr ?? "",
                            imageKey: badge.imageKey ?? "",
                            position: badge.position,
                            ruleType: badge.rule?.type ?? "",
                            threshold: badge.rule?.threshold ?? 0,
                            forumId: badge.rule?.forumId ?? "",
                          });
                          setEditing(true);
                        }}
                      >
                        {t("staff.badges.edit")}
                      </button>
                      <button
                        type="button"
                        data-badge-delete={badge.id}
                        onClick={() => mutate.mutate({ action: "delete", id: badge.id })}
                      >
                        {t("staff.badges.delete")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {editing ? (
            <section className="admin-panel">
              <h2>{draft.id === null ? t("staff.badges.create") : t("staff.badges.editTitle")}</h2>
              <div className="admin-form">
                <label>
                  <span>{t("staff.badges.key")}</span>
                  <input
                    data-badge-key
                    value={draft.key}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, key: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.badges.imageKey")}</span>
                  <input
                    data-badge-image
                    value={draft.imageKey}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, imageKey: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.badges.position")}</span>
                  <input
                    type="number"
                    min={0}
                    data-badge-position
                    value={draft.position}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, position: Number(event.target.value) }))
                    }
                  />
                </label>
              </div>
              <div className="admin-form">
                <label>
                  <span>{t("staff.badges.labelEn")}</span>
                  <input
                    data-badge-label-en
                    value={draft.en}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, en: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.badges.labelEs")}</span>
                  <input
                    data-badge-label-es
                    value={draft.es}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, es: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.badges.labelFr")}</span>
                  <input
                    data-badge-label-fr
                    value={draft.fr}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, fr: event.target.value }))
                    }
                  />
                </label>
              </div>
              <div className="admin-form">
                <label>
                  <span>{t("staff.badges.descriptionEn")}</span>
                  <input
                    data-badge-desc-en
                    value={draft.descEn}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, descEn: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.badges.descriptionEs")}</span>
                  <input
                    data-badge-desc-es
                    value={draft.descEs}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, descEs: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.badges.descriptionFr")}</span>
                  <input
                    data-badge-desc-fr
                    value={draft.descFr}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, descFr: event.target.value }))
                    }
                  />
                </label>
              </div>
              <div className="admin-form">
                <label>
                  <span>{t("staff.badges.rule")}</span>
                  <select
                    data-badge-rule
                    value={draft.ruleType}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, ruleType: event.target.value }))
                    }
                  >
                    <option value="">{t("staff.badges.manual")}</option>
                    {RULE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        <RuleLabel type={type} />
                      </option>
                    ))}
                  </select>
                </label>
                {draft.ruleType !== "" ? (
                  <>
                    <label>
                      <span>{t("staff.badges.threshold")}</span>
                      <input
                        type="number"
                        min={0}
                        data-badge-threshold
                        value={draft.threshold}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            threshold: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                    {draft.ruleType === "posts_in_forum" ? (
                      <label>
                        <span>{t("staff.badges.forumId")}</span>
                        <input
                          inputMode="numeric"
                          data-badge-forum
                          value={draft.forumId}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, forumId: event.target.value }))
                          }
                        />
                      </label>
                    ) : null}
                  </>
                ) : null}
              </div>
              <div className="admin-form">
                <button type="button" data-badge-save disabled={mutate.isPending} onClick={save}>
                  {t("staff.badges.save")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(EMPTY);
                  }}
                >
                  {t("staff.badges.cancel")}
                </button>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
