import { formatDate } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { apiGet } from "../api.ts";

interface AdminLogEntry {
  readonly id: string;
  readonly actor: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly summary: unknown;
  readonly createdAt: string;
}

interface LogFilters {
  readonly actor: string;
  readonly action: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_FILTERS: LogFilters = { actor: "", action: "", from: "", to: "" };

function filterQuery(filters: LogFilters): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value.trim() !== "") {
      params.set(key, value.trim());
    }
  }

  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export function AdminLogPage() {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState<LogFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<LogFilters>(EMPTY_FILTERS);
  const query = useQuery({
    queryKey: ["staff", "log", applied],
    queryFn: () => apiGet<{ entries: AdminLogEntry[] }>(`/api/staff/log${filterQuery(applied)}`),
  });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setApplied(draft);
  };

  const columns: readonly DataTableColumn<AdminLogEntry>[] = [
    {
      id: "action",
      headerKey: "staff.log.action",
      cell: (entry) => <span className="log-action">{entry.action}</span>,
      sortValue: (entry) => entry.action,
    },
    {
      id: "actor",
      headerKey: "staff.log.actor",
      cell: (entry) => entry.actor ?? t("staff.dashboard.log.system"),
      sortValue: (entry) => entry.actor,
    },
    {
      id: "target",
      headerKey: "staff.log.target",
      cell: (entry) =>
        [entry.targetType, entry.targetId].filter((value) => value !== null).join(" ") ||
        t("staff.log.noTarget"),
    },
    {
      id: "time",
      headerKey: "staff.log.time",
      cell: (entry) =>
        formatDate(new Date(entry.createdAt), locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      sortValue: (entry) => entry.createdAt,
    },
    {
      id: "details",
      headerKey: "staff.log.details",
      cell: (entry) => (
        <details data-log-summary>
          <summary>{t("staff.log.details")}</summary>
          <pre>{JSON.stringify(entry.summary, null, 2)}</pre>
        </details>
      ),
    },
  ];

  return (
    <div className="page" data-page="admin-log">
      <header className="page-header">
        <h1>{t("staff.log.title")}</h1>
        <p>{t("staff.log.intro")}</p>
      </header>

      <form className="log-filters" onSubmit={submit} data-log-filters>
        <label className="control">
          <span>{t("staff.log.filterActor")}</span>
          <input
            type="text"
            data-log-filter-actor
            value={draft.actor}
            onChange={(event) => setDraft({ ...draft, actor: event.target.value })}
          />
        </label>
        <label className="control">
          <span>{t("staff.log.filterAction")}</span>
          <input
            type="text"
            data-log-filter-action
            value={draft.action}
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
          />
        </label>
        <label className="control">
          <span>{t("staff.log.filterFrom")}</span>
          <input
            type="date"
            data-log-filter-from
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </label>
        <label className="control">
          <span>{t("staff.log.filterTo")}</span>
          <input
            type="date"
            data-log-filter-to
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <div className="log-filter-actions">
          <button type="submit">{t("staff.log.filter")}</button>
          <button
            type="button"
            className="dialog-cancel"
            data-log-filter-reset
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setApplied(EMPTY_FILTERS);
            }}
          >
            {t("staff.log.reset")}
          </button>
        </div>
      </form>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.log.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}
      {query.isSuccess ? (
        <DataTable
          rows={query.data.entries}
          columns={columns}
          getRowId={(entry) => entry.id}
          getRowLabel={(entry) => `${entry.action} ${entry.actor ?? ""}`}
          pageSize={20}
          emptyKey="staff.log.empty"
        />
      ) : null}
    </div>
  );
}
