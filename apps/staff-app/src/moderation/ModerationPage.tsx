import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

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

  return (
    <div className="page" data-page="moderation">
      <header className="page-header">
        <h1>{t("staff.moderation.title")}</h1>
        <p>{t("staff.moderation.intro")}</p>
        <p data-moderation-pending>
          {t("staff.moderation.pending", { count: query.data?.total ?? 0 })}
        </p>
      </header>

      {query.isPending ? <p>{t("staff.widget.loading")}</p> : null}
      {query.isError ? <p role="alert">{t("staff.widget.error")}</p> : null}

      <div className="admin-form__actions" data-moderation-actions>
        <button
          type="button"
          data-moderation-approve
          disabled={pending || selected.length === 0}
          onClick={() => mutate.mutate("approve")}
        >
          {t("staff.moderation.approve")}
        </button>
        <button
          type="button"
          className="button-quiet"
          data-moderation-reject
          disabled={pending || selected.length === 0}
          onClick={() => mutate.mutate("reject")}
        >
          {t("staff.moderation.reject")}
        </button>
      </div>

      {!query.isPending && items.length === 0 ? (
        <p className="widget-muted" data-moderation-empty>
          {t("staff.moderation.empty")}
        </p>
      ) : null}

      <ul className="moderation-list" data-moderation-list>
        {items.map((item) => (
          <li key={item.postId} className="card" data-moderation-item={item.postId}>
            <label className="check">
              <input
                type="checkbox"
                data-moderation-check={item.postId}
                checked={selected.includes(item.postId)}
                onChange={() => toggle(item.postId)}
              />
              <span>
                {item.kind === "topic"
                  ? t("staff.moderation.kindTopic")
                  : t("staff.moderation.kindPost")}
              </span>
            </label>
            <h2>{item.topicTitle}</h2>
            <p>{item.preview}</p>
            <p className="widget-muted">
              {item.authorName ?? t("staff.moderation.deletedAuthor")} · {item.forumTitle} ·{" "}
              {reasonText(t, item.reason)} ·{" "}
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(item.createdAt))}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
