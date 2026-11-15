import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  IconCheck,
  IconInbox,
  Page,
  Panel,
  QueryState,
} from "../ui/index.ts";

interface QueueItem {
  readonly postId: string;
  readonly kind: "topic" | "post";
  readonly topicId: string;
  readonly topicTitle: string;
  readonly forumTitle: string;
  readonly authorName: string | null;
  readonly preview: string;
  readonly createdAt: string;
  readonly reason: string | null;
}

interface QueueResponse {
  readonly total: number;
  readonly items: readonly QueueItem[];
}

function reasonText(t: ReturnType<typeof useT>, reason: string | null): string {
  switch (reason) {
    case "new_member":
      return t("staff.moderation.reason.new_member");
    case "group":
      return t("staff.moderation.reason.group");
    case "forum":
      return t("staff.moderation.reason.forum");
    case "warning":
      return t("staff.moderation.reason.warning");
    case "filter":
      return t("staff.moderation.reason.filter");
    case "link_limit":
      return t("staff.moderation.reason.linkLimit");
    case "duplicate":
      return t("staff.moderation.reason.duplicate");
    case "rate":
      return t("staff.moderation.reason.rate");
    case "domain_blocklist":
      return t("staff.moderation.reason.domainBlocklist");
    default:
      return t("staff.moderation.reason.other");
  }
}

export function ModerationPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const query = useQuery({
    queryKey: ["staff", "moderation", "queue"],
    queryFn: () => apiGet<QueueResponse>("/api/staff/moderation/queue?limit=100"),
  });
  const mutate = useMutation({
    mutationFn: (action: "approve" | "reject") =>
      apiPost("/api/staff/moderation/actions", { action, postIds: selected }),
    onSuccess: async (_body, action) => {
      setSelected([]);

      if (action === "approve") {
        toast.pushToast({ messageKey: "staff.moderation.approved", tone: "success" });
      } else {
        toast.pushToast({ messageKey: "staff.moderation.rejected", tone: "success" });
      }

      await queryClient.invalidateQueries({ queryKey: ["staff", "moderation"] });
      await queryClient.invalidateQueries({ queryKey: ["staff", "dashboard", "moderation"] });
    },
  });
  const items = query.data?.items ?? [];
  const toggle = (postId: string): void => {
    setSelected((current) =>
      current.includes(postId) ? current.filter((id) => id !== postId) : [...current, postId],
    );
  };
  const pending = mutate.isPending;

  const allSelected = items.length > 0 && selected.length === items.length;

  return (
    <Page
      id="moderation"
      title={t("staff.moderation.title")}
      description={t("staff.moderation.intro")}
      meta={
        <Badge tone={(query.data?.total ?? 0) > 0 ? "warning" : "neutral"} data-moderation-pending>
          {t("staff.moderation.pending", { count: query.data?.total ?? 0 })}
        </Badge>
      }
    >
      <QueryState query={query} errorLabel={t("staff.widget.error")}>
        {() => (
          <Panel flush>
            <div className="toolbar" data-moderation-actions>
              <div className="toolbar-filters">
                <Checkbox
                  label={t("staff.moderation.selectAll")}
                  data-moderation-select-all
                  checked={allSelected}
                  disabled={items.length === 0}
                  ref={(input) => {
                    if (input !== null) {
                      input.indeterminate = selected.length > 0 && !allSelected;
                    }
                  }}
                  onChange={() => setSelected(allSelected ? [] : items.map((item) => item.postId))}
                />
                {selected.length > 0 ? (
                  <span className="subtle">
                    {t("staff.moderation.selected", { count: selected.length })}
                  </span>
                ) : null}
              </div>
              <div className="toolbar-actions">
                <Button
                  data-moderation-reject
                  disabled={pending || selected.length === 0}
                  onClick={() => mutate.mutate("reject")}
                >
                  {t("staff.moderation.reject")}
                </Button>
                <Button
                  variant="primary"
                  icon={<IconCheck size={16} />}
                  data-moderation-approve
                  disabled={pending || selected.length === 0}
                  onClick={() => mutate.mutate("approve")}
                >
                  {t("staff.moderation.approve")}
                </Button>
              </div>
            </div>

            {items.length === 0 ? (
              <div data-moderation-empty>
                <EmptyState icon={<IconInbox size={22} />} title={t("staff.moderation.empty")} />
              </div>
            ) : null}

            <ul className="list" data-moderation-list>
              {items.map((item) => (
                <li
                  key={item.postId}
                  className={
                    selected.includes(item.postId)
                      ? "list-row queue-row is-selected"
                      : "list-row queue-row"
                  }
                  data-moderation-item={item.postId}
                >
                  <input
                    type="checkbox"
                    aria-label={item.topicTitle}
                    data-moderation-check={item.postId}
                    checked={selected.includes(item.postId)}
                    onChange={() => toggle(item.postId)}
                  />
                  <div className="list-row-main">
                    <span className="cluster">
                      <Badge tone={item.kind === "topic" ? "accent" : "neutral"}>
                        {item.kind === "topic"
                          ? t("staff.moderation.kindTopic")
                          : t("staff.moderation.kindPost")}
                      </Badge>
                      <h2 className="list-row-title queue-title">{item.topicTitle}</h2>
                    </span>
                    <p className="queue-preview">{item.preview}</p>
                    <span className="list-row-meta">
                      {item.authorName ?? t("staff.moderation.deletedAuthor")} · {item.forumTitle} ·{" "}
                      {reasonText(t, item.reason)} ·{" "}
                      <time dateTime={item.createdAt}>
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(item.createdAt))}
                      </time>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </QueryState>
    </Page>
  );
}
