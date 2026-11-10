import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface PromotionView {
  readonly rules: ReadonlyArray<{
    id: string;
    fromGroupId: string;
    toGroupId: string;
    fromGroupKey: string;
    toGroupKey: string;
    criteria: Readonly<Record<string, number>>;
    position: number;
    enabled: boolean;
  }>;
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
  readonly criteria: ReadonlyArray<{ key: string; labelKey: string }>;
}

interface Draft {
  readonly id: string | null;
  readonly fromGroupId: string;
  readonly toGroupId: string;
  readonly criteria: Readonly<Record<string, string>>;
  readonly position: string;
  readonly enabled: boolean;
}

const EMPTY: Draft = {
  id: null,
  fromGroupId: "",
  toGroupId: "",
  criteria: {},
  position: "0",
  enabled: true,
};

export function PromotionsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const query = useQuery({
    queryKey: ["staff", "promotions"],
    queryFn: () => apiGet<PromotionView>("/api/staff/promotions"),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/promotions", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.promotions.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "promotions"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.promotions.saveError", tone: "error" }),
  });

  useEffect(() => {
    if (query.data === undefined) {
      return;
    }

    const groups = query.data.groups;

    if (draft.fromGroupId === "" && groups[0] !== undefined) {
      setDraft((current) => ({
        ...current,
        fromGroupId: groups[0]?.id ?? "",
        toGroupId: groups[1]?.id ?? "",
      }));
    }
  }, [query.data, draft.fromGroupId]);

  const criteriaPayload = (): Record<string, number> => {
    const result: Record<string, number> = {};

    for (const [key, raw] of Object.entries(draft.criteria)) {
      const value = Number(raw);

      if (raw.trim() !== "" && Number.isFinite(value) && value >= 0) {
        result[key] = value;
      }
    }

    return result;
  };

  const selectRule = (rule: PromotionView["rules"][number]): void => {
    setDraft({
      id: rule.id,
      fromGroupId: rule.fromGroupId,
      toGroupId: rule.toGroupId,
      criteria: Object.fromEntries(
        Object.entries(rule.criteria).map(([key, value]) => [key, String(value)]),
      ),
      position: String(rule.position),
      enabled: rule.enabled,
    });
  };

  return (
    <div className="page" data-page="promotions">
      <header className="page-header">
        <h1>{t("staff.promotions.title")}</h1>
        <p>{t("staff.promotions.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.promotions.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <>
          <section className="admin-panel" aria-labelledby="promotions-list-title">
            <h2 id="promotions-list-title">{t("staff.promotions.list.title")}</h2>
            <div className="matrix-scroll">
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th scope="col">{t("staff.promotions.order")}</th>
                    <th scope="col">{t("staff.promotions.from")}</th>
                    <th scope="col">{t("staff.promotions.to")}</th>
                    <th scope="col">{t("staff.promotions.criteria")}</th>
                    <th scope="col">{t("staff.promotions.enabled")}</th>
                    <th scope="col">{t("staff.promotions.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.rules.map((rule) => (
                    <tr key={rule.id} data-promotion-row={rule.id}>
                      <td>{rule.position}</td>
                      <td>{rule.fromGroupKey}</td>
                      <td>{rule.toGroupKey}</td>
                      <td>
                        {Object.entries(rule.criteria)
                          .map(([key, value]) => {
                            const labelKey = query.data.criteria.find(
                              (criterion) => criterion.key === key,
                            )?.labelKey;
                            return `${labelKey === undefined ? key : t(labelKey)} ≥ ${value}`;
                          })
                          .join(", ")}
                      </td>
                      <td>
                        {rule.enabled
                          ? t("staff.promotions.enabled.yes")
                          : t("staff.promotions.enabled.no")}
                      </td>
                      <td>
                        <button
                          type="button"
                          data-promotion-edit={rule.id}
                          onClick={() => selectRule(rule)}
                        >
                          {t("staff.promotions.edit")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              data-promotion-new
              onClick={() =>
                setDraft({
                  ...EMPTY,
                  fromGroupId: query.data.groups[0]?.id ?? "",
                  toGroupId: query.data.groups[1]?.id ?? "",
                })
              }
            >
              {t("staff.promotions.new")}
            </button>
          </section>

          <section className="admin-panel" data-promotion-editor>
            <h2>{t("staff.promotions.editor.title")}</h2>
            <div className="admin-form">
              <label>
                <span>{t("staff.promotions.from")}</span>
                <select
                  data-promotion-from
                  value={draft.fromGroupId}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, fromGroupId: event.target.value }))
                  }
                >
                  {query.data.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("staff.promotions.to")}</span>
                <select
                  data-promotion-to
                  value={draft.toGroupId}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, toGroupId: event.target.value }))
                  }
                >
                  {query.data.groups
                    .filter((group) => group.id !== draft.fromGroupId)
                    .map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.title}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span>{t("staff.promotions.position")}</span>
                <input
                  type="number"
                  data-promotion-position
                  value={draft.position}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, position: event.target.value }))
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  data-promotion-enabled
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                <span>{t("staff.promotions.enabled")}</span>
              </label>
            </div>

            <fieldset>
              <legend>{t("staff.promotions.criteria")}</legend>
              <div className="admin-form">
                {query.data.criteria.map((criterion) => (
                  <label key={criterion.key}>
                    <span>{t(criterion.labelKey)}</span>
                    <input
                      type="number"
                      min={0}
                      data-promotion-criterion={criterion.key}
                      value={draft.criteria[criterion.key] ?? ""}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          criteria: {
                            ...current.criteria,
                            [criterion.key]: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="admin-form">
              <button
                type="button"
                data-promotion-save
                disabled={save.isPending || draft.fromGroupId === "" || draft.toGroupId === ""}
                onClick={() =>
                  save.mutate({
                    action: "save",
                    id: draft.id,
                    fromGroupId: draft.fromGroupId,
                    toGroupId: draft.toGroupId,
                    criteria: criteriaPayload(),
                    position: Number(draft.position),
                    enabled: draft.enabled,
                  })
                }
              >
                {t("staff.promotions.save")}
              </button>
              <button
                type="button"
                data-promotion-delete
                disabled={save.isPending || draft.id === null}
                onClick={() => save.mutate({ action: "delete", id: draft.id })}
              >
                {t("staff.promotions.delete")}
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
