import { formatDate, formatNumber } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api.ts";

export interface MissingObjectItem {
  readonly id: string;
  readonly kind: "attachment" | "avatar";
  readonly resourceId: string;
  readonly storageKey: string;
  readonly detectedAt: string;
  readonly postId: string | null;
}

export interface MissingObjectsReport {
  readonly total: number;
  readonly items: readonly MissingObjectItem[];
  readonly lastRun: {
    readonly id: string;
    readonly trigger: "detected" | "manual";
    readonly status: "running" | "completed" | "failed";
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly replayed: number;
    readonly removedObjects: number;
    readonly missingObjects: number;
  } | null;
}

/** Records whose stored object is missing after a restore (ADR 0020). */
export function MissingObjectsPage() {
  const t = useT();
  const locale = useLocale();
  const query = useQuery({
    queryKey: ["staff", "system", "missing-objects"],
    queryFn: () => apiGet<MissingObjectsReport>("/api/staff/system/missing-objects"),
  });
  const date = (value: string) =>
    formatDate(new Date(value), locale, { dateStyle: "medium", timeStyle: "short" });
  const columns: readonly DataTableColumn<MissingObjectItem>[] = [
    {
      id: "kind",
      headerKey: "staff.missingObjects.kind",
      cell: (item) =>
        item.kind === "attachment"
          ? t("staff.missingObjects.kindAttachment")
          : t("staff.missingObjects.kindAvatar"),
      sortValue: (item) => item.kind,
    },
    {
      id: "resource",
      headerKey: "staff.missingObjects.resource",
      cell: (item) =>
        item.kind === "attachment"
          ? t("staff.missingObjects.attachmentRef", {
              id: item.resourceId,
              post: item.postId ?? "—",
            })
          : t("staff.missingObjects.memberRef", { id: item.resourceId }),
    },
    {
      id: "key",
      headerKey: "staff.missingObjects.key",
      cell: (item) => <code className="system-key">{item.storageKey}</code>,
    },
    {
      id: "detected",
      headerKey: "staff.missingObjects.detected",
      cell: (item) => date(item.detectedAt),
      sortValue: (item) => item.detectedAt,
    },
  ];

  return (
    <div className="page" data-page="missing-objects">
      <header className="page-header">
        <h1>{t("staff.missingObjects.title")}</h1>
        <p>{t("staff.missingObjects.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.missingObjects.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}
      {query.isSuccess ? (
        <>
          <section className="widget" data-missing-last-run>
            <h2>{t("staff.missingObjects.lastRun")}</h2>
            {query.data.lastRun === null ? (
              <p className="widget-muted">{t("staff.missingObjects.noRuns")}</p>
            ) : (
              <dl className="stat-grid">
                <div>
                  <dt>{t("staff.missingObjects.runStarted")}</dt>
                  <dd>{date(query.data.lastRun.startedAt)}</dd>
                </div>
                <div>
                  <dt>{t("staff.missingObjects.runStatus")}</dt>
                  <dd data-run-status={query.data.lastRun.status}>
                    {query.data.lastRun.status === "completed"
                      ? t("staff.missingObjects.statusCompleted")
                      : query.data.lastRun.status === "failed"
                        ? t("staff.missingObjects.statusFailed")
                        : t("staff.missingObjects.statusRunning")}
                  </dd>
                </div>
                <div>
                  <dt>{t("staff.missingObjects.replayed")}</dt>
                  <dd>{formatNumber(query.data.lastRun.replayed, locale)}</dd>
                </div>
                <div>
                  <dt>{t("staff.missingObjects.removed")}</dt>
                  <dd>{formatNumber(query.data.lastRun.removedObjects, locale)}</dd>
                </div>
              </dl>
            )}
          </section>
          <p className="widget-muted" data-missing-total={query.data.total}>
            {t("staff.missingObjects.total", { count: query.data.total })}
          </p>
          <DataTable
            rows={query.data.items}
            columns={columns}
            getRowId={(item) => item.id}
            getRowLabel={(item) => item.storageKey}
            captionKey="staff.missingObjects.caption"
            emptyKey="staff.missingObjects.empty"
            pageSize={25}
          />
        </>
      ) : null}
    </div>
  );
}
