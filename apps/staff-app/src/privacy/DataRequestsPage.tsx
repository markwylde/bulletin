import { formatDate } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import { requestDueState } from "./due.ts";

interface DataRequest {
  readonly id: string;
  readonly memberId: string;
  readonly memberName: string | null;
  readonly kind: "export" | "erasure";
  readonly status: "pending" | "processing" | "completed" | "rejected" | "cancelled";
  readonly reason: string | null;
  readonly decisionReason: string | null;
  readonly postAction: "anonymise" | "delete";
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dueAt: string;
  readonly completedAt: string | null;
}

interface DataRequestsResponse {
  readonly requests: readonly DataRequest[];
}

export function DataRequestsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [overdue, setOverdue] = useState(false);
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  const [postActions, setPostActions] = useState<Readonly<Record<string, "anonymise" | "delete">>>(
    {},
  );
  const query = useQuery({
    queryKey: ["staff", "privacy", "requests", status, kind, overdue],
    queryFn: () => {
      const params = new URLSearchParams();

      if (status !== "") {
        params.set("status", status);
      }

      if (kind !== "") {
        params.set("kind", kind);
      }

      if (overdue) {
        params.set("overdue", "true");
      }

      const queryString = params.toString();
      return apiGet<DataRequestsResponse>(
        `/api/staff/privacy/requests${queryString === "" ? "" : `?${queryString}`}`,
      );
    },
  });
  const mutation = useMutation({
    mutationFn: (input: {
      readonly id: string;
      readonly action: "process" | "reject";
      readonly reason: string | null;
      readonly postAction?: "anonymise" | "delete";
    }) => apiPost<{ ok: true }>("/api/staff/privacy/requests", input),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.privacy.requests.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "privacy", "requests"] });
    },
    onError: () => {
      toast.pushToast({ messageKey: "staff.privacy.requests.error", tone: "error" });
    },
  });
  const now = Date.now();
  const dueState = (request: DataRequest): "overdue" | "soon" | "later" =>
    requestDueState(request.dueAt, request.status, now);
  const columns: readonly DataTableColumn<DataRequest>[] = [
    {
      id: "member",
      headerKey: "staff.privacy.requests.member",
      cell: (request) => request.memberName ?? `#${request.memberId}`,
      sortValue: (request) => request.memberName,
    },
    {
      id: "kind",
      headerKey: "staff.privacy.requests.kind",
      cell: (request) => t(`staff.privacy.requests.kind.${request.kind}`),
      sortValue: (request) => request.kind,
    },
    {
      id: "status",
      headerKey: "staff.privacy.requests.status",
      cell: (request) => (
        <span data-request-status={request.status}>
          {t(`staff.privacy.requests.status.${request.status}`)}
        </span>
      ),
      sortValue: (request) => request.status,
    },
    {
      id: "due",
      headerKey: "staff.privacy.requests.due",
      cell: (request) => (
        <span
          data-request-due={dueState(request)}
          data-request-overdue={dueState(request) === "overdue" ? "true" : "false"}
        >
          {formatDate(new Date(request.dueAt), locale, { dateStyle: "medium" })}
        </span>
      ),
      sortValue: (request) => request.dueAt,
    },
    {
      id: "failure",
      headerKey: "staff.privacy.requests.failure",
      cell: (request) =>
        request.lastError === null ? null : (
          <span className="bl-error-text" data-request-last-error={request.id}>
            {request.lastError}
          </span>
        ),
    },
    {
      id: "created",
      headerKey: "staff.privacy.requests.created",
      cell: (request) => formatDate(new Date(request.createdAt), locale, { dateStyle: "medium" }),
      sortValue: (request) => request.createdAt,
    },
  ];

  return (
    <div className="page" data-page="privacy-requests">
      <header className="page-header">
        <h1>{t("staff.privacy.requests.title")}</h1>
        <p>{t("staff.privacy.requests.intro")}</p>
      </header>

      <div className="admin-form" data-request-filters>
        <label>
          <span>{t("staff.privacy.requests.filterStatus")}</span>
          <select
            data-request-filter-status
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">{t("staff.privacy.requests.filterAll")}</option>
            <option value="pending">{t("staff.privacy.requests.status.pending")}</option>
            <option value="processing">{t("staff.privacy.requests.status.processing")}</option>
            <option value="completed">{t("staff.privacy.requests.status.completed")}</option>
            <option value="rejected">{t("staff.privacy.requests.status.rejected")}</option>
            <option value="cancelled">{t("staff.privacy.requests.status.cancelled")}</option>
          </select>
        </label>
        <label>
          <span>{t("staff.privacy.requests.filterKind")}</span>
          <select
            data-request-filter-kind
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">{t("staff.privacy.requests.filterAll")}</option>
            <option value="export">{t("staff.privacy.requests.kind.export")}</option>
            <option value="erasure">{t("staff.privacy.requests.kind.erasure")}</option>
          </select>
        </label>
        <label className="control">
          <span>{t("staff.privacy.requests.filterOverdue")}</span>
          <input
            type="checkbox"
            data-request-filter-overdue
            checked={overdue}
            onChange={(event) => setOverdue(event.target.checked)}
          />
        </label>
      </div>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.privacy.requests.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}
      {query.isSuccess ? (
        <DataTable
          rows={query.data.requests}
          columns={columns}
          getRowId={(request) => request.id}
          getRowLabel={(request) =>
            `${request.memberName ?? request.memberId} ${t(`staff.privacy.requests.kind.${request.kind}`)}`
          }
          rowClassName={(request) => {
            const state = dueState(request);

            return state === "overdue"
              ? "data-row-overdue"
              : state === "soon"
                ? "data-row-due-soon"
                : undefined;
          }}
          rowActions={(request) => (
            <div className="data-request-actions">
              {request.kind === "erasure" ? (
                <select
                  data-request-post-action={request.id}
                  aria-label={t("staff.privacy.requests.postAction")}
                  value={postActions[request.id] ?? request.postAction}
                  onChange={(event) =>
                    setPostActions({
                      ...postActions,
                      [request.id]: event.target.value as "anonymise" | "delete",
                    })
                  }
                >
                  <option value="anonymise">{t("staff.privacy.requests.keepPosts")}</option>
                  <option value="delete">{t("staff.privacy.requests.deletePosts")}</option>
                </select>
              ) : null}
              <input
                type="text"
                data-request-reason={request.id}
                aria-label={t("staff.privacy.requests.reason")}
                placeholder={t("staff.privacy.requests.reason")}
                value={reasons[request.id] ?? ""}
                onChange={(event) => setReasons({ ...reasons, [request.id]: event.target.value })}
              />
              <button
                type="button"
                data-request-process={request.id}
                disabled={mutation.isPending || request.status !== "pending"}
                onClick={() =>
                  mutation.mutate({
                    id: request.id,
                    action: "process",
                    reason: reasons[request.id]?.trim() || null,
                    ...(request.kind === "erasure"
                      ? { postAction: postActions[request.id] ?? request.postAction }
                      : {}),
                  })
                }
              >
                {t("staff.privacy.requests.process")}
              </button>
              <button
                type="button"
                className="button-danger"
                data-request-reject={request.id}
                disabled={mutation.isPending || request.status !== "pending"}
                onClick={() =>
                  mutation.mutate({
                    id: request.id,
                    action: "reject",
                    reason: reasons[request.id]?.trim() ?? "",
                  })
                }
              >
                {t("staff.privacy.requests.reject")}
              </button>
            </div>
          )}
          pageSize={20}
          emptyKey="staff.privacy.requests.empty"
        />
      ) : null}
    </div>
  );
}
