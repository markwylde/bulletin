import { formatDate, formatNumber } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useInfiniteQuery } from "@tanstack/react-query";
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
  readonly nextCursor: string | null;
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
  // The API returns 200 rows a page; older rows load on demand with the page's cursor.
  const query = useInfiniteQuery({
    queryKey: ["staff", "system", "missing-objects"],
    queryFn: ({ pageParam }) =>
      apiGet<MissingObjectsReport>(
        pageParam === null
          ? "/api/staff/system/missing-objects"
          : `/api/staff/system/missing-objects?cursor=${encodeURIComponent(pageParam)}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const first = query.data?.pages[0];
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
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
      {query.isSuccess && first !== undefined ? (
        <>
          <section className="widget" data-missing-last-run>
            <h2>{t("staff.missingObjects.lastRun")}</h2>
            {first.lastRun === null ? (
              <p className="widget-muted">{t("staff.missingObjects.noRuns")}</p>
            ) : (
              <dl className="stat-grid">
                <div>
                  <dt>{t("staff.missingObjects.runStarted")}</dt>
                  <dd>{date(first.lastRun.startedAt)}</dd>
                </div>
                <div>
                  <dt>{t("staff.missingObjects.runStatus")}</dt>
                  <dd data-run-status={first.lastRun.status}>
                    {first.lastRun.status === "completed"
                      ? t("staff.missingObjects.statusCompleted")
                      : first.lastRun.status === "failed"
                        ? t("staff.missingObjects.statusFailed")
                        : t("staff.missingObjects.statusRunning")}
                  </dd>
                </div>
                <div>
                  <dt>{t("staff.missingObjects.replayed")}</dt>
                  <dd>{formatNumber(first.lastRun.replayed, locale)}</dd>
                </div>
                <div>
                  <dt>{t("staff.missingObjects.removed")}</dt>
                  <dd>{formatNumber(first.lastRun.removedObjects, locale)}</dd>
                </div>
              </dl>
            )}
          </section>
          <p className="widget-muted" data-missing-total={first.total}>
            {t("staff.missingObjects.total", { count: first.total })}
          </p>
          <DataTable
            rows={items}
            columns={columns}
            getRowId={(item) => item.id}
            getRowLabel={(item) => item.storageKey}
            captionKey="staff.missingObjects.caption"
            emptyKey="staff.missingObjects.empty"
            pageSize={25}
          />
          {query.hasNextPage ? (
            <div className="log-load-more">
              <button
                type="button"
                data-missing-load-more
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage
                  ? t("staff.widget.loading")
                  : t("staff.missingObjects.loadMore", { loaded: items.length })}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
