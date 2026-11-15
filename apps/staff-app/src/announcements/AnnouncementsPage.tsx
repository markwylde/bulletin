import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  IconEdit,
  IconPlus,
  IconTrash,
  Page,
  Panel,
  QueryState,
  Select,
  Switch,
  Textarea,
  TextInput,
} from "../ui/index.ts";
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
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  type TextKey = "title" | "startsAt" | "endsAt";
  const dateField = (field: Exclude<TextKey, "title">, labelKey: string, hook: string) => (
    <Field label={t(labelKey)}>
      {({ id }) => (
        <TextInput
          id={id}
          type="datetime-local"
          data-announcement-field={hook}
          value={draft[field]}
          onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
        />
      )}
    </Field>
  );
  const now = Date.now();
  const status = (announcement: AnnouncementView["announcements"][number]) => {
    const starts = new Date(announcement.startsAt).getTime();
    const ends = announcement.endsAt === null ? null : new Date(announcement.endsAt).getTime();

    if (ends !== null && ends < now) {
      return <Badge>{t("staff.announcements.status.ended")}</Badge>;
    }

    if (starts > now) {
      return <Badge tone="accent">{t("staff.announcements.status.scheduled")}</Badge>;
    }

    return (
      <Badge tone="success" dot>
        {t("staff.announcements.status.live")}
      </Badge>
    );
  };

  return (
    <Page
      id="announcements"
      title={t("staff.announcements.title")}
      description={t("staff.announcements.intro")}
      actions={
        draft.id === null ? undefined : (
          <Button
            variant="primary"
            icon={<IconPlus size={16} />}
            data-announcement-new
            onClick={() => setDraft(emptyDraft())}
          >
            {t("staff.announcements.create.title")}
          </Button>
        )
      }
    >
      <QueryState query={query} errorLabel={t("staff.announcements.loadError")}>
        {(data) => (
          <div className="page-split">
            <Panel flush title={t("staff.announcements.list.title")}>
              {data.announcements.length === 0 ? (
                <EmptyState title={t("staff.announcements.empty")} />
              ) : null}
              <ul className="list" data-announcement-list>
                {data.announcements.map((announcement) => (
                  <li
                    className={announcement.id === draft.id ? "list-row is-selected" : "list-row"}
                    key={announcement.id}
                    data-announcement-row={announcement.id}
                  >
                    <div className="list-row-main">
                      <strong className="list-row-title">{announcement.title}</strong>
                      <span className="list-row-meta">
                        {announcement.scope === "global"
                          ? t("staff.announcements.scope.global")
                          : t("staff.announcements.scope.forums", {
                              count: announcement.targets.length,
                            })}
                        {" · "}
                        {localInput(announcement.startsAt).replace("T", " ")}
                        {announcement.endsAt === null
                          ? ""
                          : ` → ${localInput(announcement.endsAt).replace("T", " ")}`}
                      </span>
                    </div>
                    {status(announcement)}
                    <div className="list-row-actions">
                      <IconButton
                        size="sm"
                        label={t("staff.announcements.edit")}
                        data-announcement-edit={announcement.id}
                        onClick={() => setDraft(draftFrom(announcement))}
                      >
                        <IconEdit size={16} />
                      </IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel
              title={
                draft.id === null
                  ? t("staff.announcements.create.title")
                  : t("staff.announcements.edit.title")
              }
            >
              <div className="stack" data-announcement-editor>
                <Field label={t("staff.announcements.field.title")}>
                  {({ id }) => (
                    <TextInput
                      id={id}
                      data-announcement-field="title"
                      value={draft.title}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, title: event.target.value }))
                      }
                    />
                  )}
                </Field>
                <Field label={t("staff.announcements.field.body")}>
                  {({ id }) => (
                    <Textarea
                      id={id}
                      rows={5}
                      data-announcement-field="body"
                      value={draft.body}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, body: event.target.value }))
                      }
                    />
                  )}
                </Field>
                <div className="form-grid">
                  {dateField("startsAt", "staff.announcements.field.startsAt", "starts-at")}
                  {dateField("endsAt", "staff.announcements.field.endsAt", "ends-at")}
                </div>
                <Field label={t("staff.announcements.field.scope")}>
                  {({ id }) => (
                    <Select
                      id={id}
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
                    </Select>
                  )}
                </Field>

                {draft.scope === "forums" ? (
                  <fieldset className="field field-group">
                    <legend className="field-label">{t("staff.announcements.field.forums")}</legend>
                    <div className="stack stack-sm">
                      {data.forums.map((forum) => {
                        const target: AnnouncementTarget | undefined = draft.targets.find(
                          (candidate) => candidate.forumId === forum.id,
                        );

                        return (
                          <div key={forum.id} className="cluster">
                            <Checkbox
                              label={forum.title}
                              data-announcement-forum={forum.id}
                              checked={target !== undefined}
                              onChange={(event) => toggleForum(forum.id, event.target.checked)}
                            />
                            {target === undefined ? null : (
                              <Checkbox
                                label={
                                  <span className="subtle">
                                    {t("staff.announcements.field.includeSubforums")}
                                  </span>
                                }
                                data-announcement-target-subforums={forum.id}
                                checked={target.includeSubforums}
                                onChange={(event) =>
                                  setTargetSubforums(forum.id, event.target.checked)
                                }
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </fieldset>
                ) : null}

                <fieldset className="field field-group">
                  <legend className="field-label">{t("staff.announcements.field.groups")}</legend>
                  <p className="field-description">{t("staff.announcements.field.groupsHelp")}</p>
                  <div className="check-grid">
                    {data.groups.map((group) => (
                      <Checkbox
                        key={group.id}
                        label={group.title}
                        data-announcement-group={group.id}
                        checked={draft.groupIds.includes(group.id)}
                        onChange={(event) => toggleGroup(group.id, event.target.checked)}
                      />
                    ))}
                  </div>
                </fieldset>

                <Switch
                  data-announcement-field="dismissible"
                  label={t("staff.announcements.field.dismissible")}
                  checked={draft.dismissible}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, dismissible: event.target.checked }))
                  }
                />

                <div className="form-actions-bar form-actions-split">
                  {draft.id === null ? (
                    <span />
                  ) : (
                    <Button
                      variant="danger"
                      icon={<IconTrash size={16} />}
                      data-announcement-delete
                      disabled={save.isPending}
                      onClick={() => setConfirmDelete(true)}
                    >
                      {t("staff.announcements.delete")}
                    </Button>
                  )}
                  <span className="cluster">
                    <Button
                      variant="ghost"
                      data-announcement-cancel
                      onClick={() => setDraft(emptyDraft())}
                    >
                      {t("staff.announcements.cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      data-announcement-save
                      disabled={save.isPending}
                      onClick={submit}
                    >
                      {t("staff.announcements.save")}
                    </Button>
                  </span>
                </div>
              </div>
            </Panel>
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={confirmDelete}
        titleKey="staff.announcements.confirmDelete.title"
        bodyKey="staff.announcements.confirmDelete.body"
        confirmLabelKey="staff.announcements.delete"
        tone="danger"
        busy={save.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          save.mutate({ action: "delete", id: draft.id });
        }}
      />
    </Page>
  );
}
