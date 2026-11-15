import { formatDate, formatNumber } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiGet } from "../api.ts";
import { Badge, Button, DescriptionList, Page, Panel, QueryState } from "../ui/index.ts";

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
    <Page
      id="missing-objects"
      title={t("staff.missingObjects.title")}
      description={t("staff.missingObjects.intro")}
    >
      <QueryState query={query} errorLabel={t("staff.missingObjects.loadError")}>
        {() =>
          first === undefined ? null : (
            <>
              <Panel title={t("staff.missingObjects.lastRun")} data-missing-last-run>
                {first.lastRun === null ? (
                  <p className="subtle">{t("staff.missingObjects.noRuns")}</p>
                ) : (
                  <DescriptionList
                    items={[
                      {
                        id: "started",
                        label: t("staff.missingObjects.runStarted"),
                        value: date(first.lastRun.startedAt),
                      },
                      {
                        id: "status",
                        label: t("staff.missingObjects.runStatus"),
                        value: (
                          <Badge
                            tone={
                              first.lastRun.status === "completed"
                                ? "success"
                                : first.lastRun.status === "failed"
                                  ? "danger"
                                  : "accent"
                            }
                            data-run-status={first.lastRun.status}
                          >
                            {first.lastRun.status === "completed"
                              ? t("staff.missingObjects.statusCompleted")
                              : first.lastRun.status === "failed"
                                ? t("staff.missingObjects.statusFailed")
                                : t("staff.missingObjects.statusRunning")}
                          </Badge>
                        ),
                      },
                      {
                        id: "replayed",
                        label: t("staff.missingObjects.replayed"),
                        value: formatNumber(first.lastRun.replayed, locale),
                      },
                      {
                        id: "removed",
                        label: t("staff.missingObjects.removed"),
                        value: formatNumber(first.lastRun.removedObjects, locale),
                      },
                    ]}
                  />
                )}
              </Panel>
              <Panel
                flush
                title={t("staff.missingObjects.caption")}
                description={
                  <span data-missing-total={first.total}>
                    {t("staff.missingObjects.total", { count: first.total })}
                  </span>
                }
              >
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
                  <div className="panel-pad cluster cluster-center">
                    <Button
                      data-missing-load-more
                      disabled={query.isFetchingNextPage}
                      onClick={() => void query.fetchNextPage()}
                    >
                      {query.isFetchingNextPage
                        ? t("staff.widget.loading")
                        : t("staff.missingObjects.loadMore", { loaded: items.length })}
                    </Button>
                  </div>
                ) : null}
              </Panel>
            </>
          )
        }
      </QueryState>
    </Page>
  );
}
