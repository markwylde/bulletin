import { formatDate } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "../api.ts";

interface AccessLogEntry {
  readonly id: string;
  readonly actorMemberId: string | null;
  readonly actorName: string | null;
  readonly subjectMemberId: string | null;
  readonly subjectName: string | null;
  readonly purpose: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly createdAt: string;
}

interface AccessLogResponse {
  readonly entries: readonly AccessLogEntry[];
}

interface AccessLogFilters {
  readonly actorId: string;
  readonly subjectId: string;
  readonly purpose: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_FILTERS: AccessLogFilters = {
  actorId: "",
  subjectId: "",
  purpose: "",
  from: "",
  to: "",
};

export function PiiAccessLogPage() {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState<AccessLogFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AccessLogFilters>(EMPTY_FILTERS);
  const query = useQuery({
    queryKey: ["staff", "privacy", "access-log", applied],
    queryFn: () => {
      const params = new URLSearchParams();

      for (const [key, value] of Object.entries(applied)) {
        if (value.trim() !== "") {
          params.set(key, value.trim());
        }
      }

      const queryString = params.toString();
      return apiGet<AccessLogResponse>(
        `/api/staff/privacy/access-log${queryString === "" ? "" : `?${queryString}`}`,
      );
    },
  });
  const columns: readonly DataTableColumn<AccessLogEntry>[] = [
    {
      id: "actor",
      headerKey: "staff.privacy.audit.actor",
      cell: (entry) => entry.actorName ?? entry.actorMemberId ?? t("staff.privacy.audit.system"),
      sortValue: (entry) => entry.actorName,
    },
    {
      id: "subject",
      headerKey: "staff.privacy.audit.subject",
      cell: (entry) => entry.subjectName ?? entry.subjectMemberId ?? t("staff.privacy.audit.none"),
      sortValue: (entry) => entry.subjectName,
    },
    {
      id: "purpose",
      headerKey: "staff.privacy.audit.purpose",
      cell: (entry) => entry.purpose,
      sortValue: (entry) => entry.purpose,
    },
    {
      id: "resource",
      headerKey: "staff.privacy.audit.resource",
      cell: (entry) =>
        [entry.resourceType, entry.resourceId].filter((value) => value !== null).join(" ") ||
        t("staff.privacy.audit.none"),
    },
    {
      id: "time",
      headerKey: "staff.privacy.audit.time",
      cell: (entry) =>
        formatDate(new Date(entry.createdAt), locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      sortValue: (entry) => entry.createdAt,
    },
  ];

  return (
    <div className="page" data-page="privacy-access-log">
      <header className="page-header">
        <h1>{t("staff.privacy.audit.title")}</h1>
        <p>{t("staff.privacy.audit.intro")}</p>
      </header>

      <form
        className="admin-form"
        data-access-log-filters
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(draft);
        }}
      >
        <label>
          <span>{t("staff.privacy.audit.actor")}</span>
          <input
            data-access-log-actor
            value={draft.actorId}
            onChange={(event) => setDraft({ ...draft, actorId: event.target.value })}
          />
        </label>
        <label>
          <span>{t("staff.privacy.audit.subject")}</span>
          <input
            data-access-log-subject
            value={draft.subjectId}
            onChange={(event) => setDraft({ ...draft, subjectId: event.target.value })}
          />
        </label>
        <label>
          <span>{t("staff.privacy.audit.purpose")}</span>
          <input
            data-access-log-purpose
            value={draft.purpose}
            onChange={(event) => setDraft({ ...draft, purpose: event.target.value })}
          />
        </label>
        <label>
          <span>{t("staff.privacy.audit.from")}</span>
          <input
            type="date"
            data-access-log-from
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </label>
        <label>
          <span>{t("staff.privacy.audit.to")}</span>
          <input
            type="date"
            data-access-log-to
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <div className="log-filter-actions">
          <button type="submit">{t("staff.privacy.audit.filter")}</button>
          <button
            type="button"
            className="dialog-cancel"
            data-access-log-reset
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setApplied(EMPTY_FILTERS);
            }}
          >
            {t("staff.privacy.audit.reset")}
          </button>
        </div>
      </form>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.privacy.audit.loadError")}</p>
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
          getRowLabel={(entry) =>
            `${entry.purpose} ${entry.actorName ?? entry.actorMemberId ?? ""}`
          }
          pageSize={20}
          emptyKey="staff.privacy.audit.empty"
        />
      ) : null}
    </div>
  );
}
