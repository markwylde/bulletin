import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface RankView {
  readonly id: string;
  readonly minPosts: number;
  readonly titleLabels: Readonly<Record<string, string>>;
  readonly pips: number;
  readonly imageKey: string | null;
}

interface RankDraft {
  readonly id: string | null;
  readonly minPosts: number;
  readonly en: string;
  readonly es: string;
  readonly fr: string;
  readonly pips: number;
  readonly imageKey: string;
}

const EMPTY: RankDraft = {
  id: null,
  minPosts: 0,
  en: "",
  es: "",
  fr: "",
  pips: 0,
  imageKey: "",
};

export function RanksPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RankDraft>(EMPTY);
  const [editing, setEditing] = useState(false);
  const query = useQuery({
    queryKey: ["staff", "ranks"],
    queryFn: () => apiGet<{ ranks: readonly RankView[] }>("/api/staff/ranks"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/ranks", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.ranks.saved", tone: "success" });
      setEditing(false);
      setDraft(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ["staff", "ranks"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.ranks.saveError", tone: "error" }),
  });

  const save = (): void => {
    if (
      draft.en.trim() === "" ||
      draft.es.trim() === "" ||
      draft.fr.trim() === "" ||
      draft.minPosts < 0 ||
      draft.pips < 0
    ) {
      toast.pushToast({ messageKey: "staff.ranks.invalid", tone: "error" });
      return;
    }

    mutate.mutate({
      action: "save",
      rank: {
        ...(draft.id === null ? {} : { id: draft.id }),
        minPosts: draft.minPosts,
        pips: draft.pips,
        imageKey: draft.imageKey.trim(),
        titleLabels: { en: draft.en, es: draft.es, fr: draft.fr },
      },
    });
  };

  return (
    <div className="page" data-page="ranks">
      <header className="page-header">
        <h1>{t("staff.ranks.title")}</h1>
        <p>{t("staff.ranks.intro")}</p>
      </header>
      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.ranks.loadError")}</p>
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
                data-rank-new
                onClick={() => {
                  setDraft(EMPTY);
                  setEditing(true);
                }}
              >
                {t("staff.ranks.add")}
              </button>
            </div>
            {query.data.ranks.length === 0 ? (
              <p className="widget-muted">{t("staff.ranks.empty")}</p>
            ) : (
              <ul className="rank-list" data-rank-list>
                {query.data.ranks.map((rank) => (
                  <li className="rank-row" key={rank.id} data-rank={rank.id}>
                    <strong>{rank.titleLabels.en ?? ""}</strong>{" "}
                    <span className="widget-muted">
                      {t("staff.ranks.minPostsValue", { count: rank.minPosts })} ·{" "}
                      {t("staff.ranks.pipsValue", { count: rank.pips })}
                    </span>
                    <div className="admin-form">
                      <button
                        type="button"
                        data-rank-edit={rank.id}
                        onClick={() => {
                          setDraft({
                            id: rank.id,
                            minPosts: rank.minPosts,
                            en: rank.titleLabels.en ?? "",
                            es: rank.titleLabels.es ?? "",
                            fr: rank.titleLabels.fr ?? "",
                            pips: rank.pips,
                            imageKey: rank.imageKey ?? "",
                          });
                          setEditing(true);
                        }}
                      >
                        {t("staff.ranks.edit")}
                      </button>
                      <button
                        type="button"
                        data-rank-delete={rank.id}
                        onClick={() => mutate.mutate({ action: "delete", id: rank.id })}
                      >
                        {t("staff.ranks.delete")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {editing ? (
            <section className="admin-panel">
              <h2>{draft.id === null ? t("staff.ranks.create") : t("staff.ranks.editTitle")}</h2>
              <div className="admin-form">
                <label>
                  <span>{t("staff.ranks.minPosts")}</span>
                  <input
                    type="number"
                    min={0}
                    data-rank-min-posts
                    value={draft.minPosts}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, minPosts: Number(event.target.value) }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.ranks.pips")}</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    data-rank-pips
                    value={draft.pips}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, pips: Number(event.target.value) }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.ranks.imageKey")}</span>
                  <input
                    data-rank-image
                    value={draft.imageKey}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, imageKey: event.target.value }))
                    }
                  />
                </label>
              </div>
              <div className="admin-form">
                <label>
                  <span>{t("staff.ranks.labelEn")}</span>
                  <input
                    data-rank-label-en
                    value={draft.en}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, en: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.ranks.labelEs")}</span>
                  <input
                    data-rank-label-es
                    value={draft.es}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, es: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.ranks.labelFr")}</span>
                  <input
                    data-rank-label-fr
                    value={draft.fr}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, fr: event.target.value }))
                    }
                  />
                </label>
              </div>
              <div className="admin-form">
                <button type="button" data-rank-save disabled={mutate.isPending} onClick={save}>
                  {t("staff.ranks.save")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(EMPTY);
                  }}
                >
                  {t("staff.ranks.cancel")}
                </button>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
