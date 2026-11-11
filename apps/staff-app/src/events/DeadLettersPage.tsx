import { formatDate } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../api.ts";

interface DeadLetter {
  readonly id: string;
  readonly queue: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly error: string | null;
  readonly failedAt: string | null;
  readonly attempts: number;
}

interface DeadLetterPage {
  readonly entries: readonly DeadLetter[];
  readonly total: number;
}

function describePayload(payload: Readonly<Record<string, unknown>>): string | null {
  const parts = Object.entries(payload).map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length === 0 ? null : parts.join(", ");
}

export function DeadLettersPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["staff", "dead-letters"],
    queryFn: () => apiGet<DeadLetterPage>("/api/staff/events/dead-letters?limit=100"),
  });
  const retry = useMutation({
    mutationFn: (id: string) => apiPost("/api/staff/events/dead-letters", { id }),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.deadLetters.retryQueued", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "dead-letters"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.deadLetters.retryError", tone: "error" }),
  });

  const columns: readonly DataTableColumn<DeadLetter>[] = [
    {
      id: "queue",
      headerKey: "staff.deadLetters.queue",
      cell: (entry) => <span className="dead-letter-queue">{entry.queue}</span>,
      sortValue: (entry) => entry.queue,
    },
    {
      id: "payload",
      headerKey: "staff.deadLetters.payload",
      cell: (entry) => {
        const description = describePayload(entry.payload);
        return description === null ? (
          <span className="widget-muted">{t("staff.deadLetters.none")}</span>
        ) : (
          <span className="dead-letter-payload">{description}</span>
        );
      },
    },
    {
      id: "error",
      headerKey: "staff.deadLetters.error",
      cell: (entry) =>
        entry.error === null ? (
          <span className="widget-muted">{t("staff.deadLetters.none")}</span>
        ) : (
          <code className="dead-letter-error">{entry.error}</code>
        ),
    },
    {
      id: "failedAt",
      headerKey: "staff.deadLetters.failedAt",
      cell: (entry) =>
        entry.failedAt === null
          ? t("staff.deadLetters.none")
          : formatDate(new Date(entry.failedAt), locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }),
      sortValue: (entry) => entry.failedAt,
    },
    {
      id: "attempts",
      headerKey: "staff.deadLetters.attempts",
      cell: (entry) => String(entry.attempts),
      sortValue: (entry) => entry.attempts,
      align: "end",
    },
  ];

  return (
    <div className="page" data-page="dead-letters">
      <header className="page-header">
        <h1>{t("staff.deadLetters.title")}</h1>
        <p>{t("staff.deadLetters.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.deadLetters.loadError")}</p>
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
          getRowLabel={(entry) => `${entry.queue} ${entry.id}`}
          initialSort={{ columnId: "failedAt", direction: "desc" }}
          pageSize={20}
          emptyKey="staff.deadLetters.empty"
          rowActions={(entry) => (
            <button
              type="button"
              data-dead-letter-retry={entry.id}
              disabled={retry.isPending && retry.variables === entry.id}
              onClick={() => retry.mutate(entry.id)}
            >
              {retry.isPending && retry.variables === entry.id
                ? t("staff.widget.loading")
                : t("staff.deadLetters.retry")}
            </button>
          )}
        />
      ) : null}
    </div>
  );
}
