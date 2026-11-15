import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormActions,
  IconArrowDown,
  IconArrowUp,
  IconButton,
  IconClose,
  IconEdit,
  IconGrip,
  IconPlus,
  IconTrash,
  MenuItem,
  MenuSeparator,
  Page,
  Panel,
  QueryState,
  RowActions,
  Select,
  Swatch,
  Switch,
  Textarea,
  TextInput,
} from "../ui/index.ts";

type ForumType = "category" | "forum" | "redirect";

interface ForumRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly position: number;
  readonly type: ForumType;
  readonly title: string;
  readonly slug: string;
  readonly description: string;
  readonly rules: string;
  readonly passwordProtected: boolean;
  readonly showModerators: boolean;
  readonly language: string | null;
  readonly defaultSort: "last_post" | "start_date" | "title";
  readonly prefixMode: "none" | "optional" | "required";
  readonly requireApprovalTopics: boolean;
  readonly requireApprovalPosts: boolean;
  readonly redirectUrl: string | null;
  readonly redirectClicks: number;
  readonly topicCount: number;
  readonly postCount: number;
  readonly prefixIds: readonly string[];
}

interface PrefixRecord {
  readonly id: string;
  readonly key: string;
  readonly colour: string;
  readonly labels: Readonly<Record<string, string | undefined>>;
  readonly groupIds: readonly string[];
}

interface CreateDraft {
  readonly title: string;
  readonly type: ForumType;
  readonly parentId: string;
  readonly redirectUrl: string;
}

interface SettingsDraft {
  readonly title: string;
  readonly description: string;
  readonly rules: string;
  readonly password: string;
  readonly clearPassword: boolean;
  readonly showModerators: boolean;
  readonly language: string;
  readonly defaultSort: ForumRecord["defaultSort"];
  readonly prefixMode: ForumRecord["prefixMode"];
  readonly requireApprovalTopics: boolean;
  readonly requireApprovalPosts: boolean;
  readonly prefixIds: readonly string[];
}

const EMPTY_CREATE: CreateDraft = { title: "", type: "forum", parentId: "", redirectUrl: "" };

function settingsFrom(forum: ForumRecord): SettingsDraft {
  return {
    title: forum.title,
    description: forum.description,
    rules: forum.rules,
    password: "",
    clearPassword: false,
    showModerators: forum.showModerators,
    language: forum.language ?? "",
    defaultSort: forum.defaultSort,
    prefixMode: forum.prefixMode,
    requireApprovalTopics: forum.requireApprovalTopics,
    requireApprovalPosts: forum.requireApprovalPosts,
    prefixIds: forum.prefixIds,
  };
}

function flatten(forums: readonly ForumRecord[]): Array<{ forum: ForumRecord; depth: number }> {
  const byParent = new Map<string | null, ForumRecord[]>();

  for (const forum of forums) {
    const list = byParent.get(forum.parentId) ?? [];
    list.push(forum);
    byParent.set(forum.parentId, list);
  }

  const ordered: Array<{ forum: ForumRecord; depth: number }> = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const forum of [...(byParent.get(parentId) ?? [])].sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    )) {
      ordered.push({ forum, depth });
      walk(forum.id, depth + 1);
    }
  };

  walk(null, 0);
  return ordered;
}

export function ForumsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsDraft | null>(null);
  const [deleteChoice, setDeleteChoice] = useState<"move" | "delete">("move");
  const [deleteTarget, setDeleteTarget] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["staff", "forums"],
    queryFn: () => apiGet<{ forums: ForumRecord[] }>("/api/staff/forums"),
  });
  const prefixes = useQuery({
    queryKey: ["staff", "prefixes"],
    queryFn: () => apiGet<{ prefixes: PrefixRecord[] }>("/api/staff/prefixes"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/forums", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.forums.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "forums"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.forums.saveError", tone: "error" }),
  });
  const forums = query.data?.forums ?? [];
  const rows = flatten(forums);
  const selected = forums.find((forum) => forum.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null) {
      setSettings(null);
    } else if (selected !== undefined && selected !== null) {
      setSettings(settingsFrom(selected));
    }
  }, [selectedId, selected]);

  const refreshSelection = (forum: ForumRecord | null): void => {
    setSelectedId(forum?.id ?? null);
    setSettings(forum === null ? null : settingsFrom(forum));
  };

  const move = (forumId: string, parentId: string | null, position: number): void => {
    mutate.mutate({ action: "move", id: forumId, parentId, position });
  };

  const reorder = (forum: ForumRecord, delta: -1 | 1): void => {
    const siblings = forums
      .filter((candidate) => candidate.parentId === forum.parentId)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const index = siblings.findIndex((candidate) => candidate.id === forum.id);
    const target = index + delta;

    if (index < 0 || target < 0 || target >= siblings.length) {
      return;
    }

    move(forum.id, forum.parentId, target);
  };

  const dropOn = (target: ForumRecord): void => {
    if (dragging === null || dragging === target.id) {
      return;
    }

    const dragged = forums.find((forum) => forum.id === dragging);

    if (dragged === undefined) {
      return;
    }

    if (dragged.parentId === target.parentId) {
      move(dragged.id, target.parentId, target.position);
    } else {
      move(dragged.id, target.id, forums.filter((forum) => forum.parentId === target.id).length);
    }

    setDragging(null);
  };

  const deleteForum = (forum: ForumRecord): void => {
    if (forum.topicCount > 0) {
      refreshSelection(forum);
      return;
    }

    setConfirmDeleteId(forum.id);
  };

  const patch = (update: Partial<SettingsDraft>): void =>
    setSettings((current) => (current === null ? current : { ...current, ...update }));

  const createForm = (
    <Panel title={t("staff.forums.create.title")} data-forum-create>
      <div className="stack">
        <Field label={t("staff.forums.field.title")}>
          {({ id }) => (
            <TextInput
              id={id}
              data-forum-create-field="title"
              value={createDraft.title}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, title: event.target.value }))
              }
            />
          )}
        </Field>
        <div className="form-grid">
          <Field label={t("staff.forums.field.type")}>
            {({ id }) => (
              <Select
                id={id}
                data-forum-create-type
                value={createDraft.type}
                onChange={(event) =>
                  setCreateDraft((current) => ({
                    ...current,
                    type: event.target.value as ForumType,
                  }))
                }
              >
                <option value="category">{t("staff.forums.type.category")}</option>
                <option value="forum">{t("staff.forums.type.forum")}</option>
                <option value="redirect">{t("staff.forums.type.redirect")}</option>
              </Select>
            )}
          </Field>
          <Field label={t("staff.forums.field.parent")}>
            {({ id }) => (
              <Select
                id={id}
                data-forum-create-parent
                value={createDraft.parentId}
                onChange={(event) =>
                  setCreateDraft((current) => ({ ...current, parentId: event.target.value }))
                }
              >
                <option value="">{t("staff.forums.parent.none")}</option>
                {rows.map(({ forum, depth }) => (
                  <option key={forum.id} value={forum.id}>
                    {`${"— ".repeat(depth)}${forum.title}`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {createDraft.type === "redirect" ? (
          <Field label={t("staff.forums.field.redirectUrl")}>
            {({ id }) => (
              <TextInput
                id={id}
                type="url"
                data-forum-create-field="redirect-url"
                value={createDraft.redirectUrl}
                onChange={(event) =>
                  setCreateDraft((current) => ({ ...current, redirectUrl: event.target.value }))
                }
              />
            )}
          </Field>
        ) : null}
        <FormActions>
          <Button
            variant="primary"
            data-forum-create-submit
            disabled={mutate.isPending}
            onClick={() =>
              mutate.mutate(
                {
                  action: "create",
                  title: createDraft.title,
                  type: createDraft.type,
                  parentId: createDraft.parentId === "" ? null : createDraft.parentId,
                  ...(createDraft.type === "redirect"
                    ? { redirectUrl: createDraft.redirectUrl }
                    : {}),
                },
                { onSuccess: () => setCreateDraft(EMPTY_CREATE) },
              )
            }
          >
            {t("staff.forums.create.submit")}
          </Button>
        </FormActions>
      </div>
    </Panel>
  );

  const editor =
    selected === null || settings === null ? null : (
      <div className="stack" data-forum-editor={selected.id}>
        <Panel
          title={selected.title}
          description={t("staff.forums.settings.title")}
          actions={
            <IconButton
              size="sm"
              label={t("staff.forums.cancel")}
              data-forum-settings-cancel
              onClick={() => refreshSelection(null)}
            >
              <IconClose size={16} />
            </IconButton>
          }
        >
          <div className="stack">
            <Field label={t("staff.forums.field.title")}>
              {({ id }) => (
                <TextInput
                  id={id}
                  data-forum-setting="title"
                  value={settings.title}
                  onChange={(event) => patch({ title: event.target.value })}
                />
              )}
            </Field>
            <Field label={t("staff.forums.field.description")}>
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={3}
                  data-forum-setting="description"
                  value={settings.description}
                  onChange={(event) => patch({ description: event.target.value })}
                />
              )}
            </Field>
            <Field label={t("staff.forums.field.rules")}>
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={4}
                  data-forum-setting="rules"
                  value={settings.rules}
                  onChange={(event) => patch({ rules: event.target.value })}
                />
              )}
            </Field>
            <Field label={t("staff.forums.field.password")}>
              {({ id }) => (
                <TextInput
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  data-forum-setting="password"
                  value={settings.password}
                  onChange={(event) => patch({ password: event.target.value })}
                />
              )}
            </Field>
            {selected.passwordProtected ? (
              <Checkbox
                data-forum-setting="clear-password"
                label={t("staff.forums.field.clearPassword")}
                checked={settings.clearPassword}
                onChange={(event) => patch({ clearPassword: event.target.checked })}
              />
            ) : null}
            <div className="form-grid">
              <Field label={t("staff.forums.field.language")}>
                {({ id }) => (
                  <Select
                    id={id}
                    data-forum-setting="language"
                    value={settings.language}
                    onChange={(event) => patch({ language: event.target.value })}
                  >
                    <option value="">{t("staff.forums.language.default")}</option>
                    <option value="en">{t("staff.locale.en")}</option>
                    <option value="es">{t("staff.locale.es")}</option>
                    <option value="fr">{t("staff.locale.fr")}</option>
                  </Select>
                )}
              </Field>
              <Field label={t("staff.forums.field.defaultSort")}>
                {({ id }) => (
                  <Select
                    id={id}
                    data-forum-setting="default-sort"
                    value={settings.defaultSort}
                    onChange={(event) =>
                      patch({ defaultSort: event.target.value as ForumRecord["defaultSort"] })
                    }
                  >
                    <option value="last_post">{t("staff.forums.sort.lastPost")}</option>
                    <option value="start_date">{t("staff.forums.sort.startDate")}</option>
                    <option value="title">{t("staff.forums.sort.title")}</option>
                  </Select>
                )}
              </Field>
              <Field label={t("staff.forums.field.prefixMode")}>
                {({ id }) => (
                  <Select
                    id={id}
                    data-forum-setting="prefix-mode"
                    value={settings.prefixMode}
                    onChange={(event) =>
                      patch({ prefixMode: event.target.value as ForumRecord["prefixMode"] })
                    }
                  >
                    <option value="none">{t("staff.forums.prefixMode.none")}</option>
                    <option value="optional">{t("staff.forums.prefixMode.optional")}</option>
                    <option value="required">{t("staff.forums.prefixMode.required")}</option>
                  </Select>
                )}
              </Field>
            </div>
            <div className="stack stack-sm">
              <Switch
                data-forum-setting="show-moderators"
                label={t("staff.forums.field.showModerators")}
                checked={settings.showModerators}
                onChange={(event) => patch({ showModerators: event.target.checked })}
              />
              <Switch
                data-forum-setting="require-approval-topics"
                label={t("staff.forums.field.requireApprovalTopics")}
                checked={settings.requireApprovalTopics}
                onChange={(event) => patch({ requireApprovalTopics: event.target.checked })}
              />
              <Switch
                data-forum-setting="require-approval-posts"
                label={t("staff.forums.field.requireApprovalPosts")}
                checked={settings.requireApprovalPosts}
                onChange={(event) => patch({ requireApprovalPosts: event.target.checked })}
              />
            </div>
            {(prefixes.data?.prefixes ?? []).length === 0 ? null : (
              <fieldset className="field field-group">
                <legend className="field-label">{t("staff.forums.field.prefixes")}</legend>
                <div className="check-grid">
                  {(prefixes.data?.prefixes ?? []).map((prefix) => (
                    <Checkbox
                      key={prefix.id}
                      data-forum-prefix={prefix.id}
                      label={
                        <span className="with-swatch">
                          <Swatch color={prefix.colour} />
                          {prefix.labels.en ?? prefix.key}
                        </span>
                      }
                      checked={settings.prefixIds.includes(prefix.id)}
                      onChange={(event) =>
                        patch({
                          prefixIds: event.target.checked
                            ? [...settings.prefixIds, prefix.id]
                            : settings.prefixIds.filter((id) => id !== prefix.id),
                        })
                      }
                    />
                  ))}
                </div>
              </fieldset>
            )}
            <FormActions>
              <Button variant="ghost" onClick={() => refreshSelection(null)}>
                {t("staff.forums.cancel")}
              </Button>
              <Button
                variant="primary"
                data-forum-settings-save
                disabled={mutate.isPending}
                onClick={() =>
                  mutate.mutate({
                    action: "settings",
                    id: selected.id,
                    title: settings.title,
                    description: settings.description,
                    rules: settings.rules,
                    password: settings.password,
                    clearPassword: settings.clearPassword,
                    showModerators: settings.showModerators,
                    language: settings.language === "" ? null : settings.language,
                    defaultSort: settings.defaultSort,
                    prefixMode: settings.prefixMode,
                    requireApprovalTopics: settings.requireApprovalTopics,
                    requireApprovalPosts: settings.requireApprovalPosts,
                    prefixIds: settings.prefixIds,
                    ...(selected.type === "redirect"
                      ? { redirectUrl: selected.redirectUrl ?? "" }
                      : {}),
                  })
                }
              >
                {t("staff.forums.settings.save")}
              </Button>
            </FormActions>
          </div>
        </Panel>

        {selected.topicCount > 0 ? (
          <Panel title={t("staff.forums.delete.title")} data-forum-delete-choice>
            <div className="stack">
              <p className="muted">{t("staff.forums.delete.choice")}</p>
              <div
                className="stack stack-sm"
                role="radiogroup"
                aria-label={t("staff.forums.delete.title")}
              >
                <label className="checkbox">
                  <input
                    type="radio"
                    name="topicAction"
                    value="move"
                    checked={deleteChoice === "move"}
                    onChange={() => setDeleteChoice("move")}
                  />
                  <span className="checkbox-text">
                    <span className="checkbox-label">{t("staff.forums.delete.move")}</span>
                  </span>
                </label>
                {deleteChoice === "move" ? (
                  <Select
                    aria-label={t("staff.forums.delete.target")}
                    data-forum-delete-target
                    value={deleteTarget}
                    onChange={(event) => setDeleteTarget(event.target.value)}
                  >
                    <option value="">{t("staff.forums.delete.target")}</option>
                    {forums
                      .filter((forum) => forum.id !== selected.id)
                      .map((forum) => (
                        <option key={forum.id} value={forum.id}>
                          {forum.title}
                        </option>
                      ))}
                  </Select>
                ) : null}
                <label className="checkbox">
                  <input
                    type="radio"
                    name="topicAction"
                    value="delete"
                    checked={deleteChoice === "delete"}
                    onChange={() => setDeleteChoice("delete")}
                  />
                  <span className="checkbox-text">
                    <span className="checkbox-label">{t("staff.forums.delete.topics")}</span>
                  </span>
                </label>
              </div>
              <div>
                <Button
                  variant="danger"
                  icon={<IconTrash size={16} />}
                  data-forum-delete-confirm
                  disabled={mutate.isPending || (deleteChoice === "move" && deleteTarget === "")}
                  onClick={() => setConfirmDeleteId(selected.id)}
                >
                  {t("staff.forums.delete")}
                </Button>
              </div>
            </div>
          </Panel>
        ) : null}
      </div>
    );

  const pendingDelete = forums.find((forum) => forum.id === confirmDeleteId) ?? null;

  return (
    <Page
      id="forums"
      title={t("staff.forums.title")}
      description={t("staff.forums.intro")}
      actions={
        selected === null ? undefined : (
          <Button
            variant="primary"
            icon={<IconPlus size={16} />}
            data-forum-new
            onClick={() => refreshSelection(null)}
          >
            {t("staff.forums.create.title")}
          </Button>
        )
      }
    >
      <QueryState query={query} errorLabel={t("staff.forums.loadError")}>
        {() => (
          <div className="page-split">
            <Panel
              flush
              title={t("staff.forums.tree.title")}
              description={t("staff.forums.tree.help")}
            >
              {rows.length === 0 ? (
                <EmptyState title={t("staff.forums.empty")} />
              ) : (
                <div
                  className="tree"
                  role="tree"
                  aria-label={t("staff.forums.tree.title")}
                  data-forum-root-drop
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragging !== null) {
                      move(
                        dragging,
                        null,
                        forums.filter((forum) => forum.parentId === null).length,
                      );
                      setDragging(null);
                    }
                  }}
                >
                  {rows.map(({ forum, depth }) => (
                    <div
                      className={[
                        "tree-row",
                        forum.type === "category" ? "tree-row-category" : null,
                        forum.id === selectedId ? "is-selected" : null,
                        forum.id === dragging ? "is-dragging" : null,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      role="treeitem"
                      aria-level={depth + 1}
                      aria-selected={forum.id === selectedId}
                      tabIndex={-1}
                      key={forum.id}
                      data-forum-row={forum.id}
                      data-forum-title={forum.title}
                      draggable
                      style={{
                        paddingInlineStart: `${depth * 16 + 8}px`,
                      }}
                      onDragStart={() => setDragging(forum.id)}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.stopPropagation();
                        dropOn(forum);
                      }}
                    >
                      <span className="tree-handle" aria-hidden="true">
                        <IconGrip size={16} />
                      </span>
                      <span className="tree-main">
                        <span className="tree-title">{forum.title}</span>
                        <span className="tree-meta">
                          {forum.type === "forum" ? null : (
                            <Badge>{t(`staff.forums.type.${forum.type}`)}</Badge>
                          )}
                          {forum.passwordProtected ? (
                            <Badge tone="warning">{t("staff.forums.password")}</Badge>
                          ) : null}
                          {forum.type === "forum" ? (
                            <span className="subtle">
                              {t("staff.forums.counts", {
                                topics: forum.topicCount,
                                posts: forum.postCount,
                              })}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="tree-actions">
                        <IconButton
                          size="sm"
                          label={t("staff.forums.settings")}
                          data-forum-settings={forum.id}
                          onClick={() => refreshSelection(forum)}
                        >
                          <IconEdit size={16} />
                        </IconButton>
                        <RowActions label={t("staff.rowActions")}>
                          <MenuItem
                            icon={<IconArrowUp size={16} />}
                            data-forum-move-up={forum.id}
                            onClick={() => reorder(forum, -1)}
                          >
                            {t("staff.forums.moveUp")}
                          </MenuItem>
                          <MenuItem
                            icon={<IconArrowDown size={16} />}
                            data-forum-move-down={forum.id}
                            onClick={() => reorder(forum, 1)}
                          >
                            {t("staff.forums.moveDown")}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            tone="danger"
                            icon={<IconTrash size={16} />}
                            data-forum-delete={forum.id}
                            onClick={() => deleteForum(forum)}
                          >
                            {t("staff.forums.delete")}
                          </MenuItem>
                        </RowActions>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            {editor ?? createForm}
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={pendingDelete !== null}
        titleKey="staff.forums.confirmDelete.title"
        bodyKey={
          pendingDelete !== null && pendingDelete.topicCount > 0
            ? deleteChoice === "move"
              ? "staff.forums.confirmDelete.moveBody"
              : "staff.forums.confirmDelete.topicsBody"
            : "staff.forums.confirmDelete.body"
        }
        confirmLabelKey="staff.forums.delete"
        tone="danger"
        busy={mutate.isPending}
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          const forum = pendingDelete;
          setConfirmDeleteId(null);

          if (forum === null) {
            return;
          }

          mutate.mutate(
            forum.topicCount > 0
              ? {
                  action: "delete",
                  id: forum.id,
                  topicAction: deleteChoice,
                  ...(deleteChoice === "move" ? { moveToForumId: deleteTarget } : {}),
                }
              : { action: "delete", id: forum.id },
          );

          if (selectedId === forum.id) {
            refreshSelection(null);
          }
        }}
      />
    </Page>
  );
}
