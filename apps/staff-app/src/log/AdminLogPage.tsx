import { formatDate } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useInfiniteQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { apiGet } from "../api.ts";
import { Button, Field, Page, Panel, QueryState, TextInput } from "../ui/index.ts";

interface AdminLogEntry {
  readonly id: string;
  readonly actor: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly summary: unknown;
  readonly createdAt: string;
}

interface AdminLogPage {
  readonly entries: readonly AdminLogEntry[];
  readonly nextCursor: string | null;
}

interface LogFilters {
  readonly actor: string;
  readonly action: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_FILTERS: LogFilters = { actor: "", action: "", from: "", to: "" };

function filterQuery(filters: LogFilters, cursor: string | null): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value.trim() !== "") {
      params.set(key, value.trim());
    }
  }

  if (cursor !== null) {
    params.set("cursor", cursor);
  }

  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export function AdminLogPage() {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState<LogFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<LogFilters>(EMPTY_FILTERS);
  const query = useInfiniteQuery({
    queryKey: ["staff", "log", applied],
    queryFn: ({ pageParam }) =>
      apiGet<AdminLogPage>(`/api/staff/log${filterQuery(applied, pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setApplied(draft);
  };

  const columns: readonly DataTableColumn<AdminLogEntry>[] = [
    {
      id: "action",
      primary: true,
      headerKey: "staff.log.action",
      cell: (entry) => <code className="mono">{entry.action}</code>,
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
        <details className="disclosure" data-log-summary>
          <summary>{t("staff.log.details")}</summary>
          <pre className="code-block">{JSON.stringify(entry.summary, null, 2)}</pre>
        </details>
      ),
    },
  ];

  const filterField = (
    label: string,
    hook: string,
    field: keyof LogFilters,
    type: "text" | "date" = "text",
  ) => (
    <Field label={label}>
      {({ id }) => (
        <TextInput
          id={id}
          type={type}
          {...{ [hook]: true }}
          value={draft[field]}
          onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
        />
      )}
    </Field>
  );

  return (
    <Page id="admin-log" title={t("staff.log.title")} description={t("staff.log.intro")}>
      <Panel flush>
        <form className="toolbar" onSubmit={submit} data-log-filters>
          <div className="toolbar-filters">
            {filterField(t("staff.log.filterActor"), "data-log-filter-actor", "actor")}
            {filterField(t("staff.log.filterAction"), "data-log-filter-action", "action")}
            {filterField(t("staff.log.filterFrom"), "data-log-filter-from", "from", "date")}
            {filterField(t("staff.log.filterTo"), "data-log-filter-to", "to", "date")}
          </div>
          <div className="toolbar-actions">
            <Button
              variant="ghost"
              data-log-filter-reset
              onClick={() => {
                setDraft(EMPTY_FILTERS);
                setApplied(EMPTY_FILTERS);
              }}
            >
              {t("staff.log.reset")}
            </Button>
            <Button type="submit">{t("staff.log.filter")}</Button>
          </div>
        </form>
        <QueryState query={query} errorLabel={t("staff.log.loadError")}>
          {() => (
            <>
              <DataTable
                rows={entries}
                columns={columns}
                getRowId={(entry) => entry.id}
                getRowLabel={(entry) => `${entry.action} ${entry.actor ?? ""}`}
                pageSize={20}
                emptyKey="staff.log.empty"
              />
              {query.hasNextPage ? (
                <div className="panel-pad cluster cluster-center">
                  <Button
                    data-log-load-more
                    disabled={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                  >
                    {query.isFetchingNextPage ? t("staff.widget.loading") : t("staff.log.loadMore")}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </QueryState>
      </Panel>
    </Page>
  );
}
