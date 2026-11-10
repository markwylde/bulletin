import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  type AnnouncementDraft,
  type AnnouncementRecord,
  type AnnouncementTarget,
  draftFrom,
  emptyDraft,
  iso,
  localInput,
  payloadFromDraft,
} from "./draft.ts";

interface AnnouncementView {
  readonly announcements: readonly AnnouncementRecord[];
  readonly forums: ReadonlyArray<{ id: string; parentId: string | null; title: string }>;
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
}

export function AnnouncementsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AnnouncementDraft>(emptyDraft);
  const query = useQuery({
    queryKey: ["staff", "announcements"],
    queryFn: () => apiGet<AnnouncementView>("/api/staff/announcements"),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/announcements", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.announcements.saved", tone: "success" });
      setDraft(emptyDraft());
      void queryClient.invalidateQueries({ queryKey: ["staff", "announcements"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.announcements.saveError", tone: "error" }),
  });

  const toggleGroup = (id: string, checked: boolean): void => {
    setDraft((current) => ({
      ...current,
      groupIds: checked
        ? [...current.groupIds, id]
        : current.groupIds.filter((candidate) => candidate !== id),
    }));
  };

  const toggleForum = (forumId: string, checked: boolean): void => {
    setDraft((current) => ({
      ...current,
      targets: checked
        ? [...current.targets, { forumId, includeSubforums: true }]
        : current.targets.filter((target) => target.forumId !== forumId),
    }));
  };

  const setTargetSubforums = (forumId: string, includeSubforums: boolean): void => {
    setDraft((current) => ({
      ...current,
      targets: current.targets.map((target) =>
        target.forumId === forumId ? { ...target, includeSubforums } : target,
      ),
    }));
  };

  const submit = (): void => {
    if (iso(draft.startsAt) === null) {
      toast.pushToast({ messageKey: "staff.announcements.invalidSchedule", tone: "error" });
      return;
    }

    save.mutate(payloadFromDraft(draft));
  };

  return (
    <div className="page" data-page="announcements">
      <header className="page-header">
        <h1>{t("staff.announcements.title")}</h1>
        <p>{t("staff.announcements.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.announcements.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <>
          <section className="admin-panel" aria-labelledby="announcement-list-title">
            <h2 id="announcement-list-title">{t("staff.announcements.list.title")}</h2>
            <ul className="announcement-list" data-announcement-list>
              {query.data.announcements.map((announcement) => (
                <li
                  className="announcement-row"
                  key={announcement.id}
                  data-announcement-row={announcement.id}
                >
                  <div>
                    <strong>{announcement.title}</strong>
                    <p className="widget-muted">
                      {announcement.scope === "global"
                        ? t("staff.announcements.scope.global")
                        : t("staff.announcements.scope.forums", {
                            count: announcement.targets.length,
                          })}
                      {" · "}
                      {localInput(announcement.startsAt)}
                      {announcement.endsAt === null ? "" : ` → ${localInput(announcement.endsAt)}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    data-announcement-edit={announcement.id}
                    onClick={() => setDraft(draftFrom(announcement))}
                  >
                    {t("staff.announcements.edit")}
                  </button>
                </li>
              ))}
            </ul>
            {query.data.announcements.length === 0 ? (
              <p className="widget-muted">{t("staff.announcements.empty")}</p>
            ) : null}
          </section>

          <section className="admin-panel" aria-labelledby="announcement-editor-title">
            <h2 id="announcement-editor-title">
              {draft.id === null
                ? t("staff.announcements.create.title")
                : t("staff.announcements.edit.title")}
            </h2>
            <div className="admin-form" data-announcement-editor>
              <label>
                <span>{t("staff.announcements.field.title")}</span>
                <input
                  data-announcement-field="title"
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, title: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.announcements.field.body")}</span>
                <textarea
                  rows={5}
                  data-announcement-field="body"
                  value={draft.body}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, body: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.announcements.field.scope")}</span>
                <select
                  data-announcement-field="scope"
                  value={draft.scope}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      scope: event.target.value === "forums" ? "forums" : "global",
                    }))
                  }
                >
                  <option value="global">{t("staff.announcements.scope.global")}</option>
                  <option value="forums">{t("staff.announcements.scope.forumsLabel")}</option>
                </select>
              </label>
              <label>
                <span>{t("staff.announcements.field.startsAt")}</span>
                <input
                  type="datetime-local"
                  data-announcement-field="starts-at"
                  value={draft.startsAt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, startsAt: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.announcements.field.endsAt")}</span>
                <input
                  type="datetime-local"
                  data-announcement-field="ends-at"
                  value={draft.endsAt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, endsAt: event.target.value }))
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  data-announcement-field="dismissible"
                  checked={draft.dismissible}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, dismissible: event.target.checked }))
                  }
                />
                <span>{t("staff.announcements.field.dismissible")}</span>
              </label>

              {draft.scope === "forums" ? (
                <fieldset>
                  <legend>{t("staff.announcements.field.forums")}</legend>
                  <ul className="check-list">
                    {query.data.forums.map((forum) => {
                      const target: AnnouncementTarget | undefined = draft.targets.find(
                        (candidate) => candidate.forumId === forum.id,
                      );

                      return (
                        <li key={forum.id}>
                          <label>
                            <input
                              type="checkbox"
                              data-announcement-forum={forum.id}
                              checked={target !== undefined}
                              onChange={(event) => toggleForum(forum.id, event.target.checked)}
                            />
                            <span>{forum.title}</span>
                          </label>
                          {target === undefined ? null : (
                            <label className="announcement-target-subforums">
                              <input
                                type="checkbox"
                                data-announcement-target-subforums={forum.id}
                                checked={target.includeSubforums}
                                onChange={(event) =>
                                  setTargetSubforums(forum.id, event.target.checked)
                                }
                              />
                              <span>{t("staff.announcements.field.includeSubforums")}</span>
                            </label>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              ) : null}

              <fieldset>
                <legend>{t("staff.announcements.field.groups")}</legend>
                <p className="widget-muted">{t("staff.announcements.field.groupsHelp")}</p>
                <ul className="check-list">
                  {query.data.groups.map((group) => (
                    <li key={group.id}>
                      <label>
                        <input
                          type="checkbox"
                          data-announcement-group={group.id}
                          checked={draft.groupIds.includes(group.id)}
                          onChange={(event) => toggleGroup(group.id, event.target.checked)}
                        />
                        <span>{group.title}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>

              <div className="admin-form__actions">
                <button
                  type="button"
                  data-announcement-save
                  disabled={save.isPending}
                  onClick={submit}
                >
                  {t("staff.announcements.save")}
                </button>
                {draft.id !== null ? (
                  <button
                    type="button"
                    className="button-danger"
                    data-announcement-delete
                    disabled={save.isPending}
                    onClick={() => save.mutate({ action: "delete", id: draft.id })}
                  >
                    {t("staff.announcements.delete")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button-quiet"
                  data-announcement-cancel
                  onClick={() => setDraft(emptyDraft())}
                >
                  {t("staff.announcements.cancel")}
                </button>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
