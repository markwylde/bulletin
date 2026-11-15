import type { FlagRule } from "@bulletin/flags/client";
import { formatDate } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { FormRenderer, type FormValues } from "@bulletin/ui/forms";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  DescriptionList,
  EmptyState,
  IconArrowDown,
  IconArrowUp,
  IconButton,
  IconEdit,
  IconPlus,
  IconTrash,
  Page,
  Panel,
  QueryState,
} from "../ui/index.ts";
import {
  type DraftRules,
  type DraftRuleType,
  describeChange,
  describeRule,
  draftFromRules,
  ruleFormDefinition,
  rulesFromValues,
} from "./rules.ts";

interface FlagAdminView {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly defaultValue: boolean;
  readonly affectsRender: boolean;
  readonly clientVisible: boolean;
  readonly rules: readonly FlagRule[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ageDays: number;
  readonly stale: boolean;
}

interface FlagLogEntry {
  readonly id: string;
  readonly actor: string | null;
  readonly action: string;
  readonly summary: unknown;
  readonly createdAt: string;
}

const EMPTY_DRAFT: DraftRules = { rules: [], values: {} };

function RuleSummary({ rules }: { readonly rules: readonly FlagRule[] }) {
  const t = useT();

  if (rules.length === 0) {
    return <span className="subtle">{t("staff.flags.rules.none")}</span>;
  }

  return (
    <ul className="plain-list">
      {rules.map((rule, index) => (
        // Rules are an ordered list, so the position is the only stable identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: rule order is the content
        <li key={index}>{describeRule(t, rule)}</li>
      ))}
    </ul>
  );
}

function FlagEditor({
  flag,
  draft,
  submitting,
  onChange,
  onAddRule,
  onRemoveRule,
  onMoveRule,
  onSubmit,
}: {
  readonly flag: FlagAdminView;
  readonly draft: DraftRules;
  readonly submitting: boolean;
  readonly onChange: (values: FormValues) => void;
  readonly onAddRule: (type: DraftRuleType) => void;
  readonly onRemoveRule: (id: number) => void;
  readonly onMoveRule: (index: number, delta: -1 | 1) => void;
  readonly onSubmit: (rules: readonly FlagRule[]) => void;
}) {
  const t = useT();

  return (
    <Panel
      title={
        <>
          {t("staff.flags.editor.title")} <code className="mono">{flag.key}</code>
        </>
      }
      description={flag.description}
      data-flag-editor={flag.key}
    >
      <div className="stack">
        <DescriptionList
          items={[
            { id: "owner", label: t("staff.flags.owner"), value: flag.owner },
            {
              id: "default",
              label: t("staff.flags.default"),
              value: flag.defaultValue ? t("staff.flags.on") : t("staff.flags.off"),
            },
            {
              id: "render",
              label: t("staff.flags.render"),
              value: flag.affectsRender ? t("staff.flags.render.yes") : t("staff.flags.render.no"),
            },
          ]}
        />

        <div className="cluster">
          <Button
            size="sm"
            icon={<IconPlus size={16} />}
            data-add-rule="group"
            onClick={() => onAddRule("group")}
          >
            {t("staff.flags.rule.addGroup")}
          </Button>
          <Button
            size="sm"
            icon={<IconPlus size={16} />}
            data-add-rule="percentage"
            onClick={() => onAddRule("percentage")}
          >
            {t("staff.flags.rule.addPercentage")}
          </Button>
        </div>

        {draft.rules.length === 0 ? (
          <p className="subtle">{t("staff.flags.rule.none")}</p>
        ) : (
          <ol className="list step-list" aria-label={t("staff.flags.rule.order")}>
            {draft.rules.map((rule, index) => (
              <li key={rule.id} className="step-row" data-rule-order={rule.id}>
                <span className="step-row-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="step-row-main list-row-title">
                  {t("staff.flags.rule.position", { index: index + 1 })} ·{" "}
                  {rule.type === "group"
                    ? t("staff.flags.rule.typeGroup")
                    : t("staff.flags.rule.typePercentage")}
                </span>
                <span className="cluster cluster-end">
                  <IconButton
                    size="sm"
                    label={t("staff.flags.rule.moveUp")}
                    data-rule-up={rule.id}
                    disabled={index === 0}
                    onClick={() => onMoveRule(index, -1)}
                  >
                    <IconArrowUp size={16} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={t("staff.flags.rule.moveDown")}
                    data-rule-down={rule.id}
                    disabled={index === draft.rules.length - 1}
                    onClick={() => onMoveRule(index, 1)}
                  >
                    <IconArrowDown size={16} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={t("staff.flags.rule.remove")}
                    data-rule-remove={rule.id}
                    onClick={() => onRemoveRule(rule.id)}
                  >
                    <IconTrash size={16} />
                  </IconButton>
                </span>
              </li>
            ))}
          </ol>
        )}

        {/* Also rendered with no rules, so staff can save an empty list and restore the default. */}
        <FormRenderer
          definition={ruleFormDefinition(draft.rules)}
          values={draft.values}
          onChange={onChange}
          onSubmit={(values) => onSubmit(rulesFromValues(draft.rules, values))}
          submitting={submitting}
        />
      </div>
    </Panel>
  );
}

export function FlagsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRules>(EMPTY_DRAFT);
  const [nextRuleId, setNextRuleId] = useState(0);

  const flagsQuery = useQuery({
    queryKey: ["staff", "flags"],
    queryFn: () => apiGet<{ flags: FlagAdminView[] }>("/api/staff/flags"),
  });
  const logQuery = useQuery({
    queryKey: ["staff", "flags", "log"],
    queryFn: () => apiGet<{ entries: FlagLogEntry[] }>("/api/staff/flags/log"),
  });
  const selected = flagsQuery.data?.flags.find((flag) => flag.key === selectedKey) ?? null;

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["staff", "flags"] }),
      queryClient.invalidateQueries({ queryKey: ["staff", "flags", "log"] }),
    ]);
  };

  const save = useMutation({
    mutationFn: (rules: readonly FlagRule[]) =>
      apiPost<FlagAdminView>("/api/staff/flags", { key: selectedKey, rules }),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.flags.saved", tone: "success" });
      void refresh();
    },
    onError: () => {
      toast.pushToast({ messageKey: "staff.flags.saveError", tone: "error" });
    },
  });

  const selectFlag = (flag: FlagAdminView): void => {
    setSelectedKey(flag.key);
    setDraft(draftFromRules(flag.rules));
    setNextRuleId(flag.rules.length);
  };

  const addRule = (type: DraftRuleType): void => {
    setDraft((current) => ({
      rules: [...current.rules, { id: nextRuleId, type }],
      values: current.values,
    }));
    setNextRuleId((id) => id + 1);
  };

  const removeRule = (id: number): void => {
    setDraft((current) => ({
      rules: current.rules.filter((rule) => rule.id !== id),
      values: current.values,
    }));
  };

  const moveRule = (index: number, delta: -1 | 1): void => {
    setDraft((current) => {
      const rules = [...current.rules];
      const [moved] = rules.splice(index, 1);

      if (moved === undefined) {
        return current;
      }

      rules.splice(index + delta, 0, moved);
      return { rules, values: current.values };
    });
  };

  const columns: readonly DataTableColumn<FlagAdminView>[] = [
    {
      id: "key",
      headerKey: "staff.flags.key",
      cell: (flag) => <code className="mono">{flag.key}</code>,
      sortValue: (flag) => flag.key,
    },
    {
      id: "description",
      headerKey: "staff.flags.description",
      cell: (flag) => flag.description,
    },
    {
      id: "owner",
      headerKey: "staff.flags.owner",
      cell: (flag) => flag.owner,
      sortValue: (flag) => flag.owner,
    },
    {
      id: "default",
      headerKey: "staff.flags.default",
      cell: (flag) => (flag.defaultValue ? t("staff.flags.on") : t("staff.flags.off")),
      sortValue: (flag) => (flag.defaultValue ? 1 : 0),
    },
    {
      id: "rules",
      headerKey: "staff.flags.rules",
      cell: (flag) => <RuleSummary rules={flag.rules} />,
    },
    {
      id: "age",
      headerKey: "staff.flags.age",
      cell: (flag) => t("staff.flags.ageDays", { days: flag.ageDays }),
      sortValue: (flag) => flag.ageDays,
      align: "end",
    },
    {
      id: "status",
      headerKey: "staff.flags.status",
      cell: (flag) =>
        flag.stale ? (
          <Badge tone="warning" data-flag-stale={flag.key}>
            {t("staff.flags.stale")}
          </Badge>
        ) : (
          <Badge tone="success" data-flag-live={flag.key}>
            {t("staff.flags.active")}
          </Badge>
        ),
      sortValue: (flag) => (flag.stale ? 1 : 0),
    },
  ];

  return (
    <Page id="flags" title={t("staff.flags.title")} description={t("staff.flags.intro")}>
      <Panel flush title={t("staff.flags.list.title")}>
        <QueryState query={flagsQuery} errorLabel={t("staff.flags.loadError")}>
          {(data) => (
            <div data-flags-table>
              <DataTable
                rows={data.flags}
                columns={columns}
                getRowId={(flag) => flag.key}
                getRowLabel={(flag) => flag.key}
                // The flags are a code-declared inventory, not a paged dataset: paginating would
                // hide a newly added flag behind a page staff never think to open.
                paginate={false}
                captionKey="staff.flags.caption"
                emptyKey="staff.flags.empty"
                rowClassName={(flag) => (flag.stale ? "data-row-stale" : undefined)}
                rowActions={(flag) => (
                  <IconButton
                    size="sm"
                    label={t("staff.flags.edit")}
                    data-edit-flag={flag.key}
                    onClick={() => selectFlag(flag)}
                  >
                    <IconEdit size={16} />
                  </IconButton>
                )}
              />
            </div>
          )}
        </QueryState>
      </Panel>

      <div className="page-split page-split-even">
        {selected === null ? (
          <Panel title={t("staff.flags.editor.title")} data-flag-editor="none">
            <EmptyState title={t("staff.flags.choose")} />
          </Panel>
        ) : (
          <FlagEditor
            key={selected.key}
            flag={selected}
            draft={draft}
            submitting={save.isPending}
            onChange={(values) => setDraft((current) => ({ ...current, values }))}
            onAddRule={addRule}
            onRemoveRule={removeRule}
            onMoveRule={moveRule}
            onSubmit={(rules) => save.mutate(rules)}
          />
        )}

        <Panel flush title={t("staff.flags.log.title")} data-flag-log>
          <QueryState query={logQuery} errorLabel={t("staff.flags.log.loadError")}>
            {(data) =>
              data.entries.length === 0 ? (
                <EmptyState title={t("staff.flags.log.empty")} />
              ) : (
                <ul className="list">
                  {data.entries.map((entry) => (
                    <li key={entry.id} className="list-row" data-flag-log-entry={entry.id}>
                      <div className="list-row-main">
                        <span className="list-row-title">
                          {describeChange(t, entry.summary) ?? entry.action}
                        </span>
                        <span className="list-row-meta">
                          {entry.actor ?? t("staff.dashboard.log.system")} ·{" "}
                          <time dateTime={entry.createdAt}>
                            {formatDate(new Date(entry.createdAt), locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </time>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryState>
        </Panel>
      </div>
    </Page>
  );
}
