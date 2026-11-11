import { useLocale, useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface ReputationEntryView {
  readonly id: string;
  readonly postId: string;
  readonly topicId: string;
  readonly topicTitle: string;
  readonly giverId: string | null;
  readonly giverName: string | null;
  readonly receiverId: string;
  readonly points: number;
  readonly source: "vote" | "reaction";
  readonly createdAt: string;
}

interface MemberReputationView {
  readonly memberId: string;
  readonly total: number;
  readonly entries: readonly ReputationEntryView[];
}

interface MutationResponse {
  readonly ok?: boolean;
  readonly total?: number;
}

export function MemberReputationPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [memberId, setMemberId] = useState("");
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [removeEntryId, setRemoveEntryId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["staff", "member-reputation", loadedId],
    queryFn: () =>
      apiGet<MemberReputationView>(
        `/api/staff/members/reputation?memberId=${encodeURIComponent(loadedId ?? "")}`,
      ),
    enabled: loadedId !== null,
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPost<MutationResponse>("/api/staff/members/reputation", body),
    onSuccess: (_data, body) => {
      if (body.action === "recount") {
        toast.pushToast({ messageKey: "staff.reputation.recounted", tone: "success" });
      } else {
        toast.pushToast({ messageKey: "staff.reputation.removed", tone: "success" });
      }

      void queryClient.invalidateQueries({ queryKey: ["staff", "member-reputation", loadedId] });
    },
    onError: () => {
      toast.pushToast({ messageKey: "staff.reputation.actionError", tone: "error" });
    },
  });

  return (
    <div className="page" data-page="member-reputation">
      <header className="page-header">
        <h1>{t("staff.reputation.title")}</h1>
        <p>{t("staff.reputation.intro")}</p>
      </header>

      <section className="admin-panel" aria-labelledby="reputation-lookup-title">
        <h2 id="reputation-lookup-title">{t("staff.reputation.lookup.title")}</h2>
        <div className="admin-form">
          <label>
            <span>{t("staff.reputation.memberId")}</span>
            <input
              inputMode="numeric"
              data-reputation-member
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
            />
          </label>
          <button
            type="button"
            data-reputation-load
            disabled={!/^\d+$/.test(memberId)}
            onClick={() => setLoadedId(memberId)}
          >
            {t("staff.reputation.load")}
          </button>
        </div>
        {query.isError ? (
          <div className="widget-error" role="alert">
            <p>{t("staff.reputation.loadError")}</p>
            <button type="button" onClick={() => void query.refetch()}>
              {t("staff.widget.retry")}
            </button>
          </div>
        ) : null}
        {query.isPending && loadedId !== null ? (
          <p className="widget-muted">{t("staff.widget.loading")}</p>
        ) : null}
      </section>

      {query.isSuccess ? (
        <section className="admin-panel" aria-labelledby="reputation-entries-title">
          <h2 id="reputation-entries-title">{t("staff.reputation.entries.title")}</h2>
          <p data-reputation-total>
            {t("staff.reputation.total")}: <strong>{query.data.total}</strong>
          </p>
          <div className="admin-form">
            <button
              type="button"
              data-reputation-recount
              disabled={mutate.isPending}
              onClick={() => mutate.mutate({ action: "recount", memberId: query.data.memberId })}
            >
              {t("staff.reputation.recount")}
            </button>
          </div>

          {query.data.entries.length === 0 ? (
            <p className="widget-muted">{t("staff.reputation.empty")}</p>
          ) : (
            <div className="matrix-scroll" data-matrix-scroll>
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th scope="col">{t("staff.reputation.points")}</th>
                    <th scope="col">{t("staff.reputation.source")}</th>
                    <th scope="col">{t("staff.reputation.giver")}</th>
                    <th scope="col">{t("staff.reputation.topic")}</th>
                    <th scope="col">{t("staff.reputation.when")}</th>
                    <th scope="col">{t("staff.reputation.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.entries.map((entry) => (
                    <tr key={entry.id} data-reputation-entry={entry.id}>
                      <td data-label={t("staff.reputation.points")}>{entry.points}</td>
                      <td data-label={t("staff.reputation.source")}>
                        {entry.source === "vote"
                          ? t("staff.reputation.source.vote")
                          : t("staff.reputation.source.reaction")}
                      </td>
                      <td data-label={t("staff.reputation.giver")}>
                        {entry.giverName ?? t("staff.reputation.unknownGiver")}
                      </td>
                      <td data-label={t("staff.reputation.topic")}>{entry.topicTitle}</td>
                      <td data-label={t("staff.reputation.when")}>
                        {new Date(entry.createdAt).toLocaleString(locale)}
                      </td>
                      <td data-label={t("staff.reputation.actions")}>
                        <button
                          type="button"
                          data-reputation-remove={entry.id}
                          disabled={mutate.isPending}
                          onClick={() => setRemoveEntryId(entry.id)}
                        >
                          {t("staff.reputation.remove")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <ConfirmDialog
            open={removeEntryId !== null}
            titleKey="staff.reputation.confirm.title"
            bodyKey="staff.reputation.confirm.body"
            confirmLabelKey="staff.reputation.remove"
            tone="danger"
            busy={mutate.isPending}
            onConfirm={() => {
              const entryId = removeEntryId;
              setRemoveEntryId(null);

              if (entryId !== null && loadedId !== null) {
                mutate.mutate({ action: "remove", memberId: loadedId, entryId });
              }
            }}
            onCancel={() => setRemoveEntryId(null)}
          />
        </section>
      ) : null}
    </div>
  );
}
