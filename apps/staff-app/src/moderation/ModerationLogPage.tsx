import { useT } from "@bulletin/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "../api.ts";
import { EmptyState, Field, Notice, Page, Panel, Skeleton, Table, TextInput } from "../ui/index.ts";

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

  const filter = (
    label: string,
    hook: string,
    value: string,
    set: (value: string) => void,
    numeric = false,
  ) => (
    <Field label={label}>
      {({ id }) => (
        <TextInput
          id={id}
          {...{ [hook]: true }}
          inputMode={numeric ? "numeric" : undefined}
          value={value}
          onChange={(event) => set(event.target.value)}
        />
      )}
    </Field>
  );

  return (
    <Page id="moderation-log" title={t("staff.modlog.title")} description={t("staff.modlog.intro")}>
      <Panel flush>
        <div className="toolbar" data-modlog-filters>
          <div className="toolbar-filters">
            {filter(t("staff.modlog.action"), "data-modlog-action", action, setAction)}
            {filter(t("staff.modlog.actor"), "data-modlog-actor", actorId, setActorId, true)}
            {filter(t("staff.modlog.forum"), "data-modlog-forum", forumId, setForumId, true)}
            {filter(t("staff.modlog.member"), "data-modlog-member", memberId, setMemberId, true)}
          </div>
        </div>
        {query.isPending ? (
          <div className="panel-body">
            <Skeleton lines={5} label={t("staff.widget.loading")} />
          </div>
        ) : query.isError ? (
          <div className="panel-body">
            <Notice tone="danger" role="alert" title={t("staff.widget.error")} />
          </div>
        ) : (
          <div data-modlog-list>
            <Table
              caption={t("staff.modlog.title")}
              rows={query.data.entries}
              rowKey={(entry) => entry.id}
              rowProps={(entry) => ({ "data-modlog-entry": entry.id })}
              empty={<EmptyState title={t("staff.modlog.empty")} />}
              columns={[
                {
                  id: "action",
                  header: t("staff.modlog.action"),
                  primary: true,
                  cell: (entry) => <code>{entry.action}</code>,
                },
                {
                  id: "actor",
                  header: t("staff.modlog.moderator"),
                  cell: (entry) => entry.actorName ?? t("staff.dashboard.log.system"),
                },
                {
                  id: "context",
                  header: t("staff.modlog.context"),
                  cell: (entry) => (
                    <span className="muted break">
                      {[
                        entry.forumTitle,
                        entry.memberName,
                        entry.targetType === null
                          ? null
                          : `${entry.targetType}:${entry.targetId ?? ""}`,
                      ]
                        .filter((part) => part !== null && part !== "")
                        .join(" · ")}
                    </span>
                  ),
                },
                {
                  id: "when",
                  header: t("staff.modlog.when"),
                  cell: (entry) => (
                    <time dateTime={entry.createdAt} className="muted">
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Panel>
    </Page>
  );
}
