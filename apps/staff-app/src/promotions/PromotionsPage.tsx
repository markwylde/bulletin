import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconArrowRight,
  IconButton,
  IconEdit,
  IconPlus,
  IconTrash,
  Page,
  Panel,
  QueryState,
  Select,
  Switch,
  Table,
  TextInput,
} from "../ui/index.ts";

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
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  const groupTitle = (id: string, key: string): string =>
    query.data?.groups.find((group) => group.id === id)?.title ?? key;

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

  const criteriaText = (view: PromotionView, rule: PromotionView["rules"][number]): string =>
    Object.entries(rule.criteria)
      .map(([key, value]) => {
        const labelKey = view.criteria.find((criterion) => criterion.key === key)?.labelKey;
        return `${labelKey === undefined ? key : t(labelKey)} ≥ ${value}`;
      })
      .join(", ");

  return (
    <Page
      id="promotions"
      title={t("staff.promotions.title")}
      description={t("staff.promotions.intro")}
      actions={
        query.isSuccess ? (
          <Button
            variant="primary"
            icon={<IconPlus size={16} />}
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
          </Button>
        ) : undefined
      }
    >
      <QueryState query={query} errorLabel={t("staff.promotions.loadError")}>
        {(view) => (
          <div className="page-split">
            <Panel title={t("staff.promotions.list.title")} flush>
              <Table
                caption={t("staff.promotions.list.title")}
                rows={view.rules}
                rowKey={(rule) => rule.id}
                rowProps={(rule) => ({
                  "data-promotion-row": rule.id,
                  className: rule.id === draft.id ? "is-selected" : undefined,
                })}
                empty={<EmptyState title={t("staff.promotions.empty")} />}
                columns={[
                  {
                    id: "order",
                    header: t("staff.promotions.order"),
                    width: "4rem",
                    cell: (rule) => rule.position,
                  },
                  {
                    id: "path",
                    header: `${t("staff.promotions.from")} → ${t("staff.promotions.to")}`,
                    primary: true,
                    cell: (rule) => (
                      <span className="cluster">
                        <span>{groupTitle(rule.fromGroupId, rule.fromGroupKey)}</span>
                        <IconArrowRight size={14} className="muted" />
                        <span>{groupTitle(rule.toGroupId, rule.toGroupKey)}</span>
                      </span>
                    ),
                  },
                  {
                    id: "criteria",
                    header: t("staff.promotions.criteria"),
                    cell: (rule) => criteriaText(view, rule),
                  },
                  {
                    id: "enabled",
                    header: t("staff.promotions.enabled"),
                    cell: (rule) =>
                      rule.enabled ? (
                        <Badge tone="success" dot>
                          {t("staff.promotions.enabled.yes")}
                        </Badge>
                      ) : (
                        <Badge>{t("staff.promotions.enabled.no")}</Badge>
                      ),
                  },
                  {
                    id: "actions",
                    header: t("staff.promotions.actions"),
                    align: "end",
                    width: "3rem",
                    cell: (rule) => (
                      <IconButton
                        size="sm"
                        label={t("staff.promotions.edit")}
                        data-promotion-edit={rule.id}
                        onClick={() => selectRule(rule)}
                      >
                        <IconEdit size={16} />
                      </IconButton>
                    ),
                  },
                ]}
              />
            </Panel>

            <Panel
              data-promotion-editor
              title={
                draft.id === null ? t("staff.promotions.new") : t("staff.promotions.editor.title")
              }
            >
              <div className="stack">
                <div className="form-grid">
                  <Field label={t("staff.promotions.from")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        data-promotion-from
                        value={draft.fromGroupId}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, fromGroupId: event.target.value }))
                        }
                      >
                        {view.groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.title}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t("staff.promotions.to")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        data-promotion-to
                        value={draft.toGroupId}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, toGroupId: event.target.value }))
                        }
                      >
                        {view.groups
                          .filter((group) => group.id !== draft.fromGroupId)
                          .map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.title}
                            </option>
                          ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t("staff.promotions.position")}>
                    {({ id }) => (
                      <TextInput
                        id={id}
                        type="number"
                        data-promotion-position
                        value={draft.position}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, position: event.target.value }))
                        }
                      />
                    )}
                  </Field>
                </div>
                <Switch
                  data-promotion-enabled
                  label={t("staff.promotions.enabled")}
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                <fieldset className="field field-group">
                  <legend className="field-label">{t("staff.promotions.criteria")}</legend>
                  <div className="form-grid">
                    {view.criteria.map((criterion) => (
                      <Field key={criterion.key} label={t(criterion.labelKey)}>
                        {({ id }) => (
                          <TextInput
                            id={id}
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
                        )}
                      </Field>
                    ))}
                  </div>
                </fieldset>
                <div className="form-actions-bar form-actions-split">
                  {draft.id === null ? (
                    <span />
                  ) : (
                    <Button
                      variant="danger"
                      icon={<IconTrash size={16} />}
                      data-promotion-delete
                      disabled={save.isPending}
                      onClick={() => setConfirmDelete(true)}
                    >
                      {t("staff.promotions.delete")}
                    </Button>
                  )}
                  <Button
                    variant="primary"
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
                  </Button>
                </div>
              </div>
            </Panel>
            <ConfirmDialog
              open={confirmDelete}
              titleKey="staff.promotions.confirmDelete.title"
              bodyKey="staff.promotions.confirmDelete.body"
              confirmLabelKey="staff.promotions.delete"
              tone="danger"
              busy={save.isPending}
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => {
                setConfirmDelete(false);
                save.mutate(
                  { action: "delete", id: draft.id },
                  {
                    onSuccess: () =>
                      setDraft({
                        ...EMPTY,
                        fromGroupId: view.groups[0]?.id ?? "",
                        toGroupId: view.groups[1]?.id ?? "",
                      }),
                  },
                );
              }}
            />
          </div>
        )}
      </QueryState>
    </Page>
  );
}
