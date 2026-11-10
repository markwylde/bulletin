import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

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

    mutate.mutate({ action: "delete", id: forum.id });

    if (selectedId === forum.id) {
      refreshSelection(null);
    }
  };

  return (
    <div className="page" data-page="forums">
      <header className="page-header">
        <h1>{t("staff.forums.title")}</h1>
        <p>{t("staff.forums.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.forums.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <>
          <section className="admin-panel" aria-labelledby="forum-tree-title">
            <h2 id="forum-tree-title">{t("staff.forums.tree.title")}</h2>
            <p className="widget-muted">{t("staff.forums.tree.help")}</p>
            <div
              className="forum-tree"
              role="tree"
              data-forum-root-drop
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragging !== null) {
                  move(dragging, null, forums.filter((forum) => forum.parentId === null).length);
                  setDragging(null);
                }
              }}
            >
              {rows.map(({ forum, depth }) => (
                <div
                  className="forum-tree__row"
                  role="treeitem"
                  aria-level={depth + 1}
                  tabIndex={-1}
                  key={forum.id}
                  data-forum-row={forum.id}
                  data-forum-title={forum.title}
                  draggable
                  style={{ paddingInlineStart: `${depth * 16 + 8}px` }}
                  onDragStart={() => setDragging(forum.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.stopPropagation();
                    dropOn(forum);
                  }}
                >
                  <span className="forum-tree__handle" aria-hidden="true">
                    ⋮⋮
                  </span>
                  <span className="forum-tree__title">{forum.title}</span>
                  <span className="forum-tag">{t(`staff.forums.type.${forum.type}`)}</span>
                  {forum.passwordProtected ? (
                    <span className="forum-tag">{t("staff.forums.password")}</span>
                  ) : null}
                  <div className="forum-tree__actions">
                    <button
                      type="button"
                      className="button-quiet"
                      data-forum-move-up={forum.id}
                      onClick={() => reorder(forum, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="button-quiet"
                      data-forum-move-down={forum.id}
                      onClick={() => reorder(forum, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      data-forum-settings={forum.id}
                      onClick={() => refreshSelection(forum)}
                    >
                      {t("staff.forums.settings")}
                    </button>
                    <button
                      type="button"
                      className="button-danger"
                      data-forum-delete={forum.id}
                      onClick={() => deleteForum(forum)}
                    >
                      {t("staff.forums.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {rows.length === 0 ? <p className="widget-muted">{t("staff.forums.empty")}</p> : null}
          </section>

          <section className="admin-panel" aria-labelledby="forum-create-title">
            <h2 id="forum-create-title">{t("staff.forums.create.title")}</h2>
            <div className="admin-form" data-forum-create>
              <label>
                <span>{t("staff.forums.field.title")}</span>
                <input
                  data-forum-create-field="title"
                  value={createDraft.title}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, title: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.forums.field.type")}</span>
                <select
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
                </select>
              </label>
              <label>
                <span>{t("staff.forums.field.parent")}</span>
                <select
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
                </select>
              </label>
              {createDraft.type === "redirect" ? (
                <label>
                  <span>{t("staff.forums.field.redirectUrl")}</span>
                  <input
                    data-forum-create-field="redirect-url"
                    value={createDraft.redirectUrl}
                    onChange={(event) =>
                      setCreateDraft((current) => ({ ...current, redirectUrl: event.target.value }))
                    }
                  />
                </label>
              ) : null}
              <div className="admin-form__actions">
                <button
                  type="button"
                  data-forum-create-submit
                  disabled={mutate.isPending}
                  onClick={() =>
                    mutate.mutate({
                      action: "create",
                      title: createDraft.title,
                      type: createDraft.type,
                      parentId: createDraft.parentId === "" ? null : createDraft.parentId,
                      ...(createDraft.type === "redirect"
                        ? { redirectUrl: createDraft.redirectUrl }
                        : {}),
                    })
                  }
                >
                  {t("staff.forums.create.submit")}
                </button>
              </div>
            </div>
          </section>

          {selected !== null && settings !== null ? (
            <section
              className="admin-panel"
              data-forum-editor={selected.id}
              aria-labelledby="forum-settings-title"
            >
              <h2 id="forum-settings-title">{t("staff.forums.settings.title")}</h2>
              <div className="admin-form">
                <label>
                  <span>{t("staff.forums.field.title")}</span>
                  <input
                    data-forum-setting="title"
                    value={settings.title}
                    onChange={(event) =>
                      setSettings((current) =>
                        current === null ? current : { ...current, title: event.target.value },
                      )
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.forums.field.description")}</span>
                  <textarea
                    rows={3}
                    data-forum-setting="description"
                    value={settings.description}
                    onChange={(event) =>
                      setSettings((current) =>
                        current === null
                          ? current
                          : { ...current, description: event.target.value },
                      )
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.forums.field.rules")}</span>
                  <textarea
                    rows={5}
                    data-forum-setting="rules"
                    value={settings.rules}
                    onChange={(event) =>
                      setSettings((current) =>
                        current === null ? current : { ...current, rules: event.target.value },
                      )
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.forums.field.password")}</span>
                  <input
                    type="password"
                    data-forum-setting="password"
                    value={settings.password}
                    onChange={(event) =>
                      setSettings((current) =>
                        current === null ? current : { ...current, password: event.target.value },
                      )
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    data-forum-setting="clear-password"
                    checked={settings.clearPassword}
                    onChange={(event) =>
                      setSettings((current) =>
                        current === null
                          ? current
                          : { ...current, clearPassword: event.target.checked },
                      )
                    }
                  />
                  <span>{t("staff.forums.field.clearPassword")}</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    data-forum-setting="show-moderators"
                    checked={settings.showModerators}
                    onChange={(event) =>
                      setSettings((current) =>
                        current === null
                          ? current
                          : { ...current, showModerators: event.target.checked },
                      )
                    }
                  />
                  <span>{t("staff.forums.field.showModerators")}</span>
                </label>
                <label>
                  <span>{t("staff.forums.field.language")}</span>
                  <select
                    data-forum-setting="language"
                    value={settings.language}
                    onChange={(event) =>
                      setSettings((current) =>
                        current === null ? current : { ...current, language: event.target.value },
                      )
                    }
                  >
                    <option value="">{t("staff.forums.language.default")}</option>
                    <option value="en">{t("staff.locale.en")}</option>
                    <option value="es">{t("staff.locale.es")}</option>
                    <option value="fr">{t("staff.locale.fr")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("staff.forums.field.defaultSort")}</span>
                  <select
                    data-forum-setting="default-sort"
                    value={settings.defaultSort}
                    onChange={(event) =>
                      setSettings((current) =>
                        current === null
                          ? current
                          : {
                              ...current,
                              defaultSort: event.target.value as ForumRecord["defaultSort"],
                            },
                      )
                    }
                  >
                    <option value="last_post">{t("staff.forums.sort.lastPost")}</option>
                    <option value="start_date">{t("staff.forums.sort.startDate")}</option>
                    <option value="title">{t("staff.forums.sort.title")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("staff.forums.field.prefixMode")}</span>
                  <select
                    data-forum-setting="prefix-mode"
                    value={settings.prefixMode}
                    onChange={(event) =>
                      setSettings((current) =>
                        current === null
                          ? current
                          : {
                              ...current,
                              prefixMode: event.target.value as ForumRecord["prefixMode"],
                            },
                      )
                    }
                  >
                    <option value="none">{t("staff.forums.prefixMode.none")}</option>
                    <option value="optional">{t("staff.forums.prefixMode.optional")}</option>
                    <option value="required">{t("staff.forums.prefixMode.required")}</option>
                  </select>
                </label>
                <fieldset>
                  <legend>{t("staff.forums.field.prefixes")}</legend>
                  <ul className="check-list">
                    {(prefixes.data?.prefixes ?? []).map((prefix) => (
                      <li key={prefix.id}>
                        <label>
                          <input
                            type="checkbox"
                            data-forum-prefix={prefix.id}
                            checked={settings.prefixIds.includes(prefix.id)}
                            onChange={(event) =>
                              setSettings((current) =>
                                current === null
                                  ? current
                                  : {
                                      ...current,
                                      prefixIds: event.target.checked
                                        ? [...current.prefixIds, prefix.id]
                                        : current.prefixIds.filter((id) => id !== prefix.id),
                                    },
                              )
                            }
                          />
                          <span>{prefix.labels.en ?? prefix.key}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
                <div className="admin-form__actions">
                  <button
                    type="button"
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
                        prefixIds: settings.prefixIds,
                        ...(selected.type === "redirect"
                          ? { redirectUrl: selected.redirectUrl ?? "" }
                          : {}),
                      })
                    }
                  >
                    {t("staff.forums.settings.save")}
                  </button>
                  <button
                    type="button"
                    className="button-quiet"
                    data-forum-settings-cancel
                    onClick={() => refreshSelection(null)}
                  >
                    {t("staff.forums.cancel")}
                  </button>
                </div>
                {selected.topicCount > 0 ? (
                  <div className="forum-delete-choice" data-forum-delete-choice>
                    <p>{t("staff.forums.delete.choice")}</p>
                    <label>
                      <input
                        type="radio"
                        name="topicAction"
                        value="move"
                        checked={deleteChoice === "move"}
                        onChange={() => setDeleteChoice("move")}
                      />
                      <span>{t("staff.forums.delete.move")}</span>
                    </label>
                    {deleteChoice === "move" ? (
                      <select
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
                      </select>
                    ) : null}
                    <label>
                      <input
                        type="radio"
                        name="topicAction"
                        value="delete"
                        checked={deleteChoice === "delete"}
                        onChange={() => setDeleteChoice("delete")}
                      />
                      <span>{t("staff.forums.delete.topics")}</span>
                    </label>
                    <button
                      type="button"
                      className="button-danger"
                      data-forum-delete-confirm
                      onClick={() =>
                        mutate.mutate({
                          action: "delete",
                          id: selected.id,
                          topicAction: deleteChoice,
                          ...(deleteChoice === "move" ? { moveToForumId: deleteTarget } : {}),
                        })
                      }
                    >
                      {t("staff.forums.delete")}
                    </button>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
