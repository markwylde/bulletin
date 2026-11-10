import { MODERATOR_POWERS, type ModeratorPower } from "@bulletin/domain/permissions";
import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface ModeratorView {
  readonly assignments: ReadonlyArray<{
    id: string;
    forumId: string;
    memberId: string | null;
    groupId: string | null;
    memberName: string | null;
    groupKey: string | null;
    powers: readonly ModeratorPower[];
    thisForumOnly: boolean;
  }>;
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
  readonly members: ReadonlyArray<{ id: string; displayName: string }>;
  readonly forums: ReadonlyArray<{ id: string; parentId: string | null }>;
  readonly powers: readonly ModeratorPower[];
}

interface Draft {
  readonly id: string | null;
  readonly forumId: string;
  readonly assigneeKind: "member" | "group";
  readonly assigneeId: string;
  readonly powers: readonly ModeratorPower[];
  readonly thisForumOnly: boolean;
}

const EMPTY: Draft = {
  id: null,
  forumId: "",
  assigneeKind: "member",
  assigneeId: "",
  powers: [],
  thisForumOnly: false,
};

export function ModeratorsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const query = useQuery({
    queryKey: ["staff", "moderators"],
    queryFn: () => apiGet<ModeratorView>("/api/staff/moderators"),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/moderators", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.moderators.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "moderators"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.moderators.saveError", tone: "error" }),
  });

  useEffect(() => {
    if (query.data !== undefined && draft.forumId === "" && query.data.forums[0] !== undefined) {
      setDraft((current) => ({ ...current, forumId: query.data?.forums[0]?.id ?? "" }));
    }
  }, [query.data, draft.forumId]);

  const assignees =
    draft.assigneeKind === "member"
      ? (query.data?.members.map((member) => ({ id: member.id, label: member.displayName })) ?? [])
      : (query.data?.groups.map((group) => ({ id: group.id, label: group.title })) ?? []);

  const selectAssignment = (assignment: ModeratorView["assignments"][number]): void => {
    setDraft({
      id: assignment.id,
      forumId: assignment.forumId,
      assigneeKind: assignment.memberId === null ? "group" : "member",
      assigneeId: assignment.memberId ?? assignment.groupId ?? "",
      powers: assignment.powers,
      thisForumOnly: assignment.thisForumOnly,
    });
  };

  return (
    <div className="page" data-page="moderators">
      <header className="page-header">
        <h1>{t("staff.moderators.title")}</h1>
        <p>{t("staff.moderators.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.moderators.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <>
          {query.data.forums.length === 0 ? (
            <p className="widget-muted">{t("staff.moderators.noForums")}</p>
          ) : null}
          <section className="admin-panel" aria-labelledby="moderators-list-title">
            <h2 id="moderators-list-title">{t("staff.moderators.list.title")}</h2>
            <div className="matrix-scroll">
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th scope="col">{t("staff.moderators.forum")}</th>
                    <th scope="col">{t("staff.moderators.assignee")}</th>
                    <th scope="col">{t("staff.moderators.powers")}</th>
                    <th scope="col">{t("staff.moderators.scope")}</th>
                    <th scope="col">{t("staff.moderators.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.assignments.map((assignment) => (
                    <tr key={assignment.id} data-moderator-row={assignment.id}>
                      <th scope="row">{`#${assignment.forumId}`}</th>
                      <td>{assignment.memberName ?? assignment.groupKey ?? ""}</td>
                      <td>{assignment.powers.join(", ")}</td>
                      <td>
                        {assignment.thisForumOnly
                          ? t("staff.moderators.thisForumOnly")
                          : t("staff.moderators.inherited")}
                      </td>
                      <td>
                        <button
                          type="button"
                          data-moderator-edit={assignment.id}
                          onClick={() => selectAssignment(assignment)}
                        >
                          {t("staff.moderators.edit")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="admin-panel" data-moderator-editor>
            <h2>{t("staff.moderators.editor.title")}</h2>
            <div className="admin-form">
              <label>
                <span>{t("staff.moderators.forum")}</span>
                <select
                  data-moderator-forum
                  value={draft.forumId}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, forumId: event.target.value }))
                  }
                >
                  {query.data.forums.map((forum) => (
                    <option key={forum.id} value={forum.id}>
                      {`#${forum.id}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("staff.moderators.assigneeKind")}</span>
                <select
                  data-moderator-kind
                  value={draft.assigneeKind}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      assigneeKind: event.target.value === "group" ? "group" : "member",
                      assigneeId: "",
                    }))
                  }
                >
                  <option value="member">{t("staff.moderators.member")}</option>
                  <option value="group">{t("staff.moderators.group")}</option>
                </select>
              </label>
              <label>
                <span>{t("staff.moderators.assignee")}</span>
                <select
                  data-moderator-assignee
                  value={draft.assigneeId}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, assigneeId: event.target.value }))
                  }
                >
                  <option value="">{t("staff.moderators.assignee.none")}</option>
                  {assignees.map((assignee) => (
                    <option key={assignee.id} value={assignee.id}>
                      {assignee.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  data-moderator-scope
                  checked={draft.thisForumOnly}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      thisForumOnly: event.target.checked,
                    }))
                  }
                />
                <span>{t("staff.moderators.thisForumOnly")}</span>
              </label>
            </div>

            <fieldset>
              <legend>{t("staff.moderators.powers")}</legend>
              <ul className="check-list">
                {MODERATOR_POWERS.map((power) => (
                  <li key={power}>
                    <label>
                      <input
                        type="checkbox"
                        data-moderator-power={power}
                        checked={draft.powers.includes(power)}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            powers: event.target.checked
                              ? [...current.powers, power]
                              : current.powers.filter((item) => item !== power),
                          }))
                        }
                      />
                      <span>{t(`staff.groups.power.${power}`)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>

            <div className="admin-form">
              <button
                type="button"
                data-moderator-save
                disabled={save.isPending || draft.forumId === "" || draft.assigneeId === ""}
                onClick={() =>
                  save.mutate({
                    action: "save",
                    id: draft.id,
                    forumId: draft.forumId,
                    assigneeKind: draft.assigneeKind,
                    assigneeId: draft.assigneeId,
                    powers: draft.powers,
                    thisForumOnly: draft.thisForumOnly,
                  })
                }
              >
                {t("staff.moderators.save")}
              </button>
              <button
                type="button"
                data-moderator-delete
                disabled={save.isPending || draft.id === null}
                onClick={() => save.mutate({ action: "delete", id: draft.id })}
              >
                {t("staff.moderators.delete")}
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
