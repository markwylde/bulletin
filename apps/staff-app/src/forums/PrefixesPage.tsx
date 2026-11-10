import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface PrefixRecord {
  readonly id: string;
  readonly key: string;
  readonly colour: string;
  readonly labels: Readonly<Record<string, string | undefined>>;
  readonly groupIds: readonly string[];
}

interface PrefixView {
  readonly prefixes: readonly PrefixRecord[];
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
}

interface Draft {
  readonly id: string | null;
  readonly key: string;
  readonly colour: string;
  readonly en: string;
  readonly es: string;
  readonly fr: string;
  readonly groupIds: readonly string[];
}

const EMPTY: Draft = {
  id: null,
  key: "",
  colour: "#6b7280",
  en: "",
  es: "",
  fr: "",
  groupIds: [],
};

function draftFrom(prefix: PrefixRecord): Draft {
  return {
    id: prefix.id,
    key: prefix.key,
    colour: prefix.colour,
    en: prefix.labels.en ?? "",
    es: prefix.labels.es ?? "",
    fr: prefix.labels.fr ?? "",
    groupIds: prefix.groupIds,
  };
}

export function PrefixesPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const query = useQuery({
    queryKey: ["staff", "prefixes"],
    queryFn: () => apiGet<PrefixView>("/api/staff/prefixes"),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/prefixes", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.prefixes.saved", tone: "success" });
      setDraft(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ["staff", "prefixes"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.prefixes.saveError", tone: "error" }),
  });

  useEffect(() => {
    if (query.isSuccess && draft.id !== null) {
      const current = query.data.prefixes.find((prefix) => prefix.id === draft.id);

      if (current !== undefined) {
        setDraft(draftFrom(current));
      }
    }
  }, [query.data, query.isSuccess, draft.id]);

  const toggleGroup = (groupId: string, checked: boolean): void => {
    setDraft((current) => ({
      ...current,
      groupIds: checked
        ? [...current.groupIds, groupId]
        : current.groupIds.filter((id) => id !== groupId),
    }));
  };

  return (
    <div className="page" data-page="prefixes">
      <header className="page-header">
        <h1>{t("staff.prefixes.title")}</h1>
        <p>{t("staff.prefixes.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.prefixes.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <>
          <section className="admin-panel" aria-labelledby="prefix-list-title">
            <h2 id="prefix-list-title">{t("staff.prefixes.list.title")}</h2>
            <ul className="prefix-list" data-prefix-list>
              {query.data.prefixes.map((prefix) => (
                <li className="prefix-row" key={prefix.id} data-prefix-row={prefix.key}>
                  <span
                    className="prefix-swatch"
                    style={{ backgroundColor: prefix.colour }}
                    aria-hidden="true"
                  />
                  <span className="prefix-row__label">{prefix.labels.en ?? prefix.key}</span>
                  <span className="log-action">{prefix.key}</span>
                  <span className="widget-muted">
                    {prefix.groupIds.length === 0
                      ? t("staff.prefixes.groups.all")
                      : prefix.groupIds
                          .map(
                            (groupId) =>
                              query.data.groups.find((group) => group.id === groupId)?.title ??
                              groupId,
                          )
                          .join(", ")}
                  </span>
                  <button
                    type="button"
                    data-prefix-edit={prefix.key}
                    onClick={() => setDraft(draftFrom(prefix))}
                  >
                    {t("staff.prefixes.edit")}
                  </button>
                </li>
              ))}
            </ul>
            {query.data.prefixes.length === 0 ? (
              <p className="widget-muted">{t("staff.prefixes.empty")}</p>
            ) : null}
          </section>

          <section className="admin-panel" aria-labelledby="prefix-editor-title">
            <h2 id="prefix-editor-title">
              {draft.id === null
                ? t("staff.prefixes.create.title")
                : t("staff.prefixes.edit.title")}
            </h2>
            <div className="admin-form" data-prefix-editor>
              <label>
                <span>{t("staff.prefixes.key")}</span>
                <input
                  data-prefix-field="key"
                  value={draft.key}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, key: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.prefixes.colour")}</span>
                <input
                  type="color"
                  data-prefix-field="colour"
                  value={draft.colour}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, colour: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.prefixes.label.en")}</span>
                <input
                  data-prefix-field="label-en"
                  value={draft.en}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, en: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.prefixes.label.es")}</span>
                <input
                  data-prefix-field="label-es"
                  value={draft.es}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, es: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.prefixes.label.fr")}</span>
                <input
                  data-prefix-field="label-fr"
                  value={draft.fr}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, fr: event.target.value }))
                  }
                />
              </label>
              <fieldset>
                <legend>{t("staff.prefixes.groups.title")}</legend>
                <ul className="check-list">
                  {query.data.groups.map((group) => (
                    <li key={group.id}>
                      <label>
                        <input
                          type="checkbox"
                          data-prefix-group={group.id}
                          checked={draft.groupIds.includes(group.id)}
                          onChange={(event) => toggleGroup(group.id, event.target.checked)}
                        />
                        <span>{group.title}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              <div className="admin-form__actions">
                <button
                  type="button"
                  data-prefix-save
                  disabled={save.isPending}
                  onClick={() =>
                    save.mutate({
                      action: "save",
                      ...(draft.id === null ? {} : { id: draft.id }),
                      key: draft.key,
                      colour: draft.colour,
                      labels: { en: draft.en, es: draft.es, fr: draft.fr },
                      groupIds: draft.groupIds,
                    })
                  }
                >
                  {t("staff.prefixes.save")}
                </button>
                {draft.id !== null ? (
                  <button
                    type="button"
                    className="button-danger"
                    data-prefix-delete
                    disabled={save.isPending}
                    onClick={() => save.mutate({ action: "delete", id: draft.id })}
                  >
                    {t("staff.prefixes.delete")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button-quiet"
                  data-prefix-cancel
                  onClick={() => setDraft(EMPTY)}
                >
                  {t("staff.prefixes.cancel")}
                </button>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
