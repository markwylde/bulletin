import { useLocale, useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  IconRefresh,
  IconTrash,
  MenuItem,
  Notice,
  Page,
  Panel,
  QueryState,
  RowActions,
  Skeleton,
  Table,
} from "../ui/index.ts";
import { MemberLookup } from "./MemberLookup.tsx";

interface ReputationEntryView {
  readonly id: string;
  readonly postId: string;
  readonly topicId: string;
  readonly topicTitle: string | null;
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

interface RecountRunView {
  readonly id: string;
  readonly status: "running" | "done";
  readonly reason: string;
  readonly totalMembers: number;
  readonly processedMembers: number;
  readonly changedMembers: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
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
  const recounts = useQuery({
    queryKey: ["staff", "reputation-recounts"],
    queryFn: () => apiGet<{ runs: readonly RecountRunView[] }>("/api/staff/reputation/recounts"),
    refetchInterval: 5_000,
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
    <Page
      id="member-reputation"
      title={t("staff.reputation.title")}
      description={t("staff.reputation.intro")}
    >
      <MemberLookup
        label={t("staff.reputation.memberId")}
        loadLabel={t("staff.reputation.load")}
        value={memberId}
        onChange={setMemberId}
        onLoad={(id) => {
          if (id !== null) {
            setLoadedId(id);
          }
        }}
        inputProps={{ "data-reputation-member": true }}
        buttonProps={{ "data-reputation-load": true }}
      />

      {loadedId === null ? null : (
        <QueryState query={query} errorLabel={t("staff.reputation.loadError")}>
          {(data) => (
            <Panel
              flush
              title={t("staff.reputation.entries.title")}
              description={
                <span data-reputation-total>
                  {t("staff.reputation.total")}: <strong>{data.total}</strong>
                </span>
              }
              actions={
                <Button
                  size="sm"
                  icon={<IconRefresh size={16} />}
                  data-reputation-recount
                  disabled={mutate.isPending}
                  onClick={() => mutate.mutate({ action: "recount", memberId: data.memberId })}
                >
                  {t("staff.reputation.recount")}
                </Button>
              }
            >
              <Table
                caption={t("staff.reputation.entries.title")}
                rows={data.entries}
                rowKey={(entry) => entry.id}
                rowProps={(entry) => ({ "data-reputation-entry": entry.id })}
                empty={<EmptyState title={t("staff.reputation.empty")} />}
                columns={[
                  {
                    id: "points",
                    header: t("staff.reputation.points"),
                    align: "end",
                    width: "5rem",
                    cell: (entry) => (
                      <Badge tone={entry.points < 0 ? "danger" : "success"}>
                        {entry.points > 0 ? `+${entry.points}` : entry.points}
                      </Badge>
                    ),
                  },
                  {
                    id: "source",
                    header: t("staff.reputation.source"),
                    cell: (entry) =>
                      entry.source === "vote"
                        ? t("staff.reputation.source.vote")
                        : t("staff.reputation.source.reaction"),
                  },
                  {
                    id: "giver",
                    header: t("staff.reputation.giver"),
                    cell: (entry) => entry.giverName ?? t("staff.reputation.unknownGiver"),
                  },
                  {
                    id: "topic",
                    header: t("staff.reputation.topic"),
                    primary: true,
                    cell: (entry) => entry.topicTitle ?? t("staff.reputation.hiddenTopic"),
                  },
                  {
                    id: "when",
                    header: t("staff.reputation.when"),
                    cell: (entry) => (
                      <time dateTime={entry.createdAt} className="muted">
                        {new Date(entry.createdAt).toLocaleString(locale)}
                      </time>
                    ),
                  },
                  {
                    id: "actions",
                    header: t("staff.reputation.actions"),
                    align: "end",
                    width: "3rem",
                    cell: (entry) => (
                      <RowActions label={t("staff.rowActions")}>
                        <MenuItem
                          tone="danger"
                          icon={<IconTrash size={16} />}
                          data-reputation-remove={entry.id}
                          disabled={mutate.isPending}
                          onClick={() => setRemoveEntryId(entry.id)}
                        >
                          {t("staff.reputation.remove")}
                        </MenuItem>
                      </RowActions>
                    ),
                  },
                ]}
              />
            </Panel>
          )}
        </QueryState>
      )}

      <Panel
        title={t("staff.reputation.recounts.title")}
        flush
        actions={
          <IconButton
            size="sm"
            label={t("staff.reputation.recounts.refresh")}
            onClick={() => void recounts.refetch()}
          >
            <IconRefresh size={16} />
          </IconButton>
        }
      >
        {recounts.isPending ? (
          <div className="panel-body">
            <Skeleton lines={2} label={t("staff.widget.loading")} />
          </div>
        ) : recounts.isError ? (
          <div className="panel-body">
            <Notice tone="danger" role="alert" title={t("staff.reputation.recounts.error")} />
          </div>
        ) : recounts.data.runs.length === 0 ? (
          <EmptyState title={t("staff.reputation.recounts.empty")} />
        ) : (
          <ul className="list" data-recount-list>
            {recounts.data.runs.map((run) => (
              <li key={run.id} className="list-row" data-recount-run={run.id}>
                <div className="list-row-main">
                  <span className="list-row-title">
                    {t("staff.reputation.recounts.progress", {
                      processed: run.processedMembers,
                      total: run.totalMembers,
                    })}
                  </span>
                  <span className="list-row-meta">
                    {t("staff.reputation.recounts.changed", { count: run.changedMembers })}
                  </span>
                </div>
                <Badge tone={run.status === "running" ? "accent" : "neutral"} dot>
                  {run.status === "running"
                    ? t("staff.reputation.recounts.running")
                    : t("staff.reputation.recounts.done")}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>

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
    </Page>
  );
}
