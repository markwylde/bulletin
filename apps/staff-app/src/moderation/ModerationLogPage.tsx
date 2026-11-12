import { useT } from "@bulletin/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "../api.ts";

interface LogEntry {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly forumId: string | null;
  readonly forumTitle: string | null;
  readonly memberId: string | null;
  readonly memberName: string | null;
  readonly details: unknown;
  readonly createdAt: string;
}

interface LogResponse {
  readonly allowed: boolean;
  readonly total: number;
  readonly entries: readonly LogEntry[];
}

export function ModerationLogPage() {
  const t = useT();
  const [action, setAction] = useState("");
  const [actorId, setActorId] = useState("");
  const [forumId, setForumId] = useState("");
  const [memberId, setMemberId] = useState("");
  const query = useQuery({
    queryKey: ["staff", "moderation-log", action, actorId, forumId, memberId],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (action !== "") params.set("action", action);
      if (actorId !== "") params.set("actorId", actorId);
      if (forumId !== "") params.set("forumId", forumId);
      if (memberId !== "") params.set("memberId", memberId);
      return apiGet<LogResponse>(`/api/staff/moderation-log?${params.toString()}`);
    },
  });

  return (
    <div className="page" data-page="moderation-log">
      <header className="page-header">
        <h1>{t("staff.modlog.title")}</h1>
        <p>{t("staff.modlog.intro")}</p>
      </header>

      <div className="admin-form" data-modlog-filters>
        <label>
          <span>{t("staff.modlog.action")}</span>
          <input
            data-modlog-action
            value={action}
            onChange={(event) => setAction(event.target.value)}
          />
        </label>
        <label>
          <span>{t("staff.modlog.actor")}</span>
          <input
            data-modlog-actor
            value={actorId}
            onChange={(event) => setActorId(event.target.value)}
          />
        </label>
        <label>
          <span>{t("staff.modlog.forum")}</span>
          <input
            data-modlog-forum
            value={forumId}
            onChange={(event) => setForumId(event.target.value)}
          />
        </label>
        <label>
          <span>{t("staff.modlog.member")}</span>
          <input
            data-modlog-member
            value={memberId}
            onChange={(event) => setMemberId(event.target.value)}
          />
        </label>
      </div>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? <p role="alert">{t("staff.widget.error")}</p> : null}
      {query.data !== undefined && query.data.entries.length === 0 ? (
        <p className="widget-muted">{t("staff.modlog.empty")}</p>
      ) : null}
      <ul className="log-list" data-modlog-list>
        {(query.data?.entries ?? []).map((entry) => (
          <li key={entry.id} data-modlog-entry={entry.id}>
            <span className="log-action">{entry.action}</span>
            <span className="log-actor">{entry.actorName ?? t("staff.dashboard.log.system")}</span>
            <span className="widget-muted">
              {entry.forumTitle ?? ""}
              {entry.memberName === null ? "" : ` · ${entry.memberName}`}
              {entry.targetType === null ? "" : ` · ${entry.targetType}:${entry.targetId ?? ""}`}
            </span>
            <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </div>
  );
}
