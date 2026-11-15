import { formatDate } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "../api.ts";
import { Button, Field, Page, Panel, QueryState, TextInput } from "../ui/index.ts";

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

  const textFilter = (
    labelKey: string,
    hook: string,
    field: "actorId" | "subjectId" | "purpose" | "from" | "to",
    type: "text" | "date" = "text",
  ) => (
    <Field label={t(labelKey)}>
      {({ id }) => (
        <TextInput
          id={id}
          type={type}
          {...{ [hook]: true }}
          inputMode={field === "actorId" || field === "subjectId" ? "numeric" : undefined}
          value={draft[field]}
          onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
        />
      )}
    </Field>
  );

  return (
    <Page
      id="privacy-access-log"
      title={t("staff.privacy.audit.title")}
      description={t("staff.privacy.audit.intro")}
    >
      <Panel flush>
        <form
          className="toolbar"
          data-access-log-filters
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(draft);
          }}
        >
          <div className="toolbar-filters">
            {textFilter("staff.privacy.audit.actor", "data-access-log-actor", "actorId")}
            {textFilter("staff.privacy.audit.subject", "data-access-log-subject", "subjectId")}
            {textFilter("staff.privacy.audit.purpose", "data-access-log-purpose", "purpose")}
            {textFilter("staff.privacy.audit.from", "data-access-log-from", "from", "date")}
            {textFilter("staff.privacy.audit.to", "data-access-log-to", "to", "date")}
          </div>
          <div className="toolbar-actions">
            <Button
              variant="ghost"
              data-access-log-reset
              onClick={() => {
                setDraft(EMPTY_FILTERS);
                setApplied(EMPTY_FILTERS);
              }}
            >
              {t("staff.privacy.audit.reset")}
            </Button>
            <Button type="submit">{t("staff.privacy.audit.filter")}</Button>
          </div>
        </form>
        <QueryState query={query} errorLabel={t("staff.privacy.audit.loadError")}>
          {(data) => (
            <DataTable
              rows={data.entries}
              columns={columns}
              getRowId={(entry) => entry.id}
              getRowLabel={(entry) =>
                `${entry.purpose} ${entry.actorName ?? entry.actorMemberId ?? ""}`
              }
              pageSize={20}
              emptyKey="staff.privacy.audit.empty"
            />
          )}
        </QueryState>
      </Panel>
    </Page>
  );
}
