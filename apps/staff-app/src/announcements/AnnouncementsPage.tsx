import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface AnnouncementRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly scope: "global" | "forums";
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly dismissible: boolean;
  readonly version: number;
  readonly targets: ReadonlyArray<{ forumId: string; includeSubforums: boolean }>;
  readonly groupIds: readonly string[];
}

interface AnnouncementView {
  readonly announcements: readonly AnnouncementRecord[];
  readonly forums: ReadonlyArray<{ id: string; parentId: string | null; title: string }>;
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
}

interface Draft {
  readonly id: string | null;
  readonly title: string;
  readonly body: string;
  readonly scope: "global" | "forums";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly dismissible: boolean;
  readonly forumIds: readonly string[];
  readonly includeSubforums: boolean;
  readonly groupIds: readonly string[];
}

function localInput(iso: string | null): string {
  if (iso === null) {
    return "";
  }

  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function emptyDraft(): Draft {
  return {
    id: null,
    title: "",
    body: "",
    scope: "global",
    startsAt: localInput(new Date().toISOString()),
    endsAt: "",
    dismissible: true,
    forumIds: [],
    includeSubforums: true,
    groupIds: [],
  };
}

function draftFrom(announcement: AnnouncementRecord): Draft {
  return {
    id: announcement.id,
    title: announcement.title,
    body: announcement.body,
    scope: announcement.scope,
    startsAt: localInput(announcement.startsAt),
    endsAt: localInput(announcement.endsAt),
    dismissible: announcement.dismissible,
    forumIds: announcement.targets.map((target) => target.forumId),
    includeSubforums: announcement.targets.some((target) => target.includeSubforums),
    groupIds: announcement.groupIds,
  };
}

function iso(value: string): string | null {
  if (value.trim() === "") {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function AnnouncementsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
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

  const toggle = (key: "forumIds" | "groupIds", id: string, checked: boolean): void => {
    setDraft((current) => ({
      ...current,
      [key]: checked ? [...current[key], id] : current[key].filter((candidate) => candidate !== id),
    }));
  };

  const submit = (): void => {
    const startsAt = iso(draft.startsAt);
    const endsAt = iso(draft.endsAt);

    if (startsAt === null) {
      toast.pushToast({ messageKey: "staff.announcements.invalidSchedule", tone: "error" });
      return;
    }

    save.mutate({
      action: "save",
      ...(draft.id === null ? {} : { id: draft.id }),
      title: draft.title,
      body: draft.body,
      scope: draft.scope,
      startsAt,
      endsAt,
      dismissible: draft.dismissible,
      targets:
        draft.scope === "forums"
          ? draft.forumIds.map((forumId) => ({
              forumId,
              includeSubforums: draft.includeSubforums,
            }))
          : [],
      groupIds: draft.groupIds,
    });
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
                  <label>
                    <input
                      type="checkbox"
                      data-announcement-field="include-subforums"
                      checked={draft.includeSubforums}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          includeSubforums: event.target.checked,
                        }))
                      }
                    />
                    <span>{t("staff.announcements.field.includeSubforums")}</span>
                  </label>
                  <ul className="check-list">
                    {query.data.forums.map((forum) => (
                      <li key={forum.id}>
                        <label>
                          <input
                            type="checkbox"
                            data-announcement-forum={forum.id}
                            checked={draft.forumIds.includes(forum.id)}
                            onChange={(event) => toggle("forumIds", forum.id, event.target.checked)}
                          />
                          <span>{forum.title}</span>
                        </label>
                      </li>
                    ))}
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
                          onChange={(event) => toggle("groupIds", group.id, event.target.checked)}
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
