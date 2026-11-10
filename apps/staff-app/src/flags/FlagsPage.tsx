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
    return <span className="widget-muted">{t("staff.flags.rules.none")}</span>;
  }

  return (
    <ul className="flag-rules">
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
    <section
      className="flag-editor"
      data-flag-editor={flag.key}
      aria-labelledby="flag-editor-title"
    >
      <h2 id="flag-editor-title">
        {t("staff.flags.editor.title")} <span className="log-action">{flag.key}</span>
      </h2>
      <p>{flag.description}</p>
      <dl className="flag-meta">
        <div>
          <dt>{t("staff.flags.owner")}</dt>
          <dd>{flag.owner}</dd>
        </div>
        <div>
          <dt>{t("staff.flags.default")}</dt>
          <dd>{flag.defaultValue ? t("staff.flags.on") : t("staff.flags.off")}</dd>
        </div>
        <div>
          <dt>{t("staff.flags.render")}</dt>
          <dd>{flag.affectsRender ? t("staff.flags.render.yes") : t("staff.flags.render.no")}</dd>
        </div>
      </dl>

      <div className="flag-rule-toolbar">
        <button type="button" data-add-rule="group" onClick={() => onAddRule("group")}>
          {t("staff.flags.rule.addGroup")}
        </button>
        <button type="button" data-add-rule="percentage" onClick={() => onAddRule("percentage")}>
          {t("staff.flags.rule.addPercentage")}
        </button>
      </div>

      {draft.rules.length === 0 ? (
        <p className="widget-muted">{t("staff.flags.rule.none")}</p>
      ) : (
        <ul className="flag-rule-order" aria-label={t("staff.flags.rule.order")}>
          {draft.rules.map((rule, index) => (
            <li key={rule.id} data-rule-order={rule.id}>
              <span>{t("staff.flags.rule.position", { index: index + 1 })}</span>
              <button
                type="button"
                data-rule-up={rule.id}
                disabled={index === 0}
                onClick={() => onMoveRule(index, -1)}
              >
                {t("staff.flags.rule.moveUp")}
              </button>
              <button
                type="button"
                data-rule-down={rule.id}
                disabled={index === draft.rules.length - 1}
                onClick={() => onMoveRule(index, 1)}
              >
                {t("staff.flags.rule.moveDown")}
              </button>
              <button
                type="button"
                data-rule-remove={rule.id}
                onClick={() => onRemoveRule(rule.id)}
              >
                {t("staff.flags.rule.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Also rendered with no rules, so staff can save an empty list and restore the default. */}
      <FormRenderer
        definition={ruleFormDefinition(draft.rules)}
        values={draft.values}
        onChange={onChange}
        onSubmit={(values) => onSubmit(rulesFromValues(draft.rules, values))}
        submitting={submitting}
      />
    </section>
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
      cell: (flag) => <span className="log-action">{flag.key}</span>,
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
          <span className="flag-status flag-status-stale" data-flag-stale={flag.key}>
            {t("staff.flags.stale")}
          </span>
        ) : (
          <span className="flag-status" data-flag-live={flag.key}>
            {t("staff.flags.active")}
          </span>
        ),
      sortValue: (flag) => (flag.stale ? 1 : 0),
    },
  ];

  return (
    <div className="page" data-page="flags">
      <header className="page-header">
        <h1>{t("staff.flags.title")}</h1>
        <p>{t("staff.flags.intro")}</p>
      </header>

      <section className="flags-list" aria-labelledby="flags-list-title">
        <h2 id="flags-list-title">{t("staff.flags.list.title")}</h2>
        {flagsQuery.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
        {flagsQuery.isError ? (
          <div className="widget-error" role="alert">
            <p>{t("staff.flags.loadError")}</p>
            <button type="button" onClick={() => void flagsQuery.refetch()}>
              {t("staff.widget.retry")}
            </button>
          </div>
        ) : null}
        {flagsQuery.isSuccess ? (
          <div data-flags-table>
            <DataTable
              rows={flagsQuery.data.flags}
              columns={columns}
              getRowId={(flag) => flag.key}
              getRowLabel={(flag) => flag.key}
              pageSize={20}
              captionKey="staff.flags.caption"
              emptyKey="staff.flags.empty"
              rowClassName={(flag) => (flag.stale ? "data-row-stale" : undefined)}
              rowActions={(flag) => (
                <button type="button" data-edit-flag={flag.key} onClick={() => selectFlag(flag)}>
                  {t("staff.flags.edit")}
                </button>
              )}
            />
          </div>
        ) : null}
      </section>

      {selected === null ? (
        <section className="flag-editor" data-flag-editor="none">
          <h2>{t("staff.flags.editor.title")}</h2>
          <p className="widget-muted">{t("staff.flags.choose")}</p>
        </section>
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

      <section className="flags-log" aria-labelledby="flags-log-title" data-flag-log>
        <h2 id="flags-log-title">{t("staff.flags.log.title")}</h2>
        {logQuery.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
        {logQuery.isError ? (
          <div className="widget-error" role="alert">
            <p>{t("staff.flags.log.loadError")}</p>
            <button type="button" onClick={() => void logQuery.refetch()}>
              {t("staff.widget.retry")}
            </button>
          </div>
        ) : null}
        {logQuery.isSuccess && logQuery.data.entries.length === 0 ? (
          <p className="widget-muted">{t("staff.flags.log.empty")}</p>
        ) : null}
        {logQuery.isSuccess && logQuery.data.entries.length > 0 ? (
          <ul className="log-list">
            {logQuery.data.entries.map((entry) => (
              <li key={entry.id} data-flag-log-entry={entry.id}>
                <span className="log-actor">{entry.actor ?? t("staff.dashboard.log.system")}</span>
                <time dateTime={entry.createdAt}>
                  {formatDate(new Date(entry.createdAt), locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
                <span>{describeChange(t, entry.summary) ?? entry.action}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
