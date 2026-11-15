import type { Translator } from "@bulletin/i18n";
import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FormActions,
  IconButton,
  IconClose,
  IconEdit,
  IconPlus,
  IconTrash,
  Notice,
  Page,
  Panel,
  QueryState,
  Select,
  Table,
  TextInput,
} from "../ui/index.ts";

interface MaskView {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly displayOrder: number;
  readonly groupIds: readonly string[];
}

interface MatrixView {
  readonly enabled: boolean;
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
  readonly masks: readonly MaskView[];
  readonly forums: ReadonlyArray<{ id: string; parentId: string | null }>;
  readonly actions: readonly string[];
  readonly actionBits: Readonly<Record<string, number>>;
  readonly rows: ReadonlyArray<{
    forumId: string;
    maskId: string;
    actions: number;
    inherits: boolean;
    effectiveActions: number;
  }>;
}

interface MaskDraft {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly displayOrder: string;
}

const EMPTY_DRAFT: MaskDraft = { key: "", title: "", description: "", displayOrder: "0" };

const ACTION_LABELS = {
  show: { labelKey: "staff.masks.action.show" },
  read: { labelKey: "staff.masks.action.read" },
  start: { labelKey: "staff.masks.action.start" },
  reply: { labelKey: "staff.masks.action.reply" },
  upload: { labelKey: "staff.masks.action.upload" },
  download: { labelKey: "staff.masks.action.download" },
  vote: { labelKey: "staff.masks.action.vote" },
} as const;

/**
 * Core actions have catalog labels. Plugin actions (`plugin.<id>.<name>`) are labelled from
 * the plugin's own catalog key when the staff catalog has it, otherwise from the action name,
 * so a raw key never reaches the page.
 */
export function actionLabel(t: Translator, action: string): string {
  const core = ACTION_LABELS[action as keyof typeof ACTION_LABELS];

  if (core !== undefined) {
    return t(core.labelKey);
  }

  const key = `staff.pluginForumAction.${action.replace(/^plugin\./, "")}`;
  const translated = t(key);

  if (translated !== key) {
    return translated;
  }

  const [, plugin = "", name = action] = /^plugin\.([^.]+)\.(.+)$/.exec(action) ?? [];
  const words = name.replace(/[_-]+/g, " ").trim();

  return t("staff.masks.pluginAction", {
    action: words.charAt(0).toUpperCase() + words.slice(1),
    plugin,
  });
}

function maskDraft(mask: MaskView): MaskDraft {
  return {
    key: mask.key,
    title: mask.title,
    description: mask.description,
    displayOrder: String(mask.displayOrder),
  };
}

function depthOf(view: MatrixView, forumId: string): number {
  let depth = 0;
  let current = view.forums.find((forum) => forum.id === forumId);

  while (current?.parentId !== null && current !== undefined) {
    depth += 1;
    current = view.forums.find((forum) => forum.id === current?.parentId);
  }

  return depth;
}

export function MasksPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<MaskDraft>(EMPTY_DRAFT);
  const [editDraft, setEditDraft] = useState<MaskDraft>(EMPTY_DRAFT);
  const [gridAction, setGridAction] = useState<string>("read");
  const [gridAllowed, setGridAllowed] = useState(true);
  const [gridScope, setGridScope] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const query = useQuery({
    queryKey: ["staff", "masks"],
    queryFn: () => apiGet<MatrixView>("/api/staff/masks"),
  });
  // Forum titles make the matrix readable; without access to the forum list it shows IDs.
  const forumsQuery = useQuery({
    queryKey: ["staff", "forums"],
    queryFn: () => apiGet<{ forums: { id: string; title: string }[] }>("/api/staff/forums"),
    retry: false,
  });
  const forumTitle = (forumId: string): string =>
    forumsQuery.data?.forums.find((forum) => forum.id === forumId)?.title ?? `#${forumId}`;
  const masks = query.data?.masks ?? [];
  const selected = masks.find((mask) => mask.id === selectedId) ?? masks[0] ?? null;
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/masks", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.masks.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "masks"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.masks.saveError", tone: "error" }),
  });

  useEffect(() => {
    if (selectedId === null && masks[0] !== undefined) {
      setSelectedId(masks[0].id);
    }
  }, [masks, selectedId]);

  useEffect(() => {
    if (gridScope === "" && query.data?.forums[0] !== undefined) {
      setGridScope(query.data.forums[0].id);
    }
  }, [gridScope, query.data]);

  useEffect(() => {
    if (selected !== null) {
      setEditDraft(maskDraft(selected));
    }
  }, [selected]);

  const selectedRows =
    query.data === undefined || selected === null
      ? []
      : query.data.rows.filter((row) => row.maskId === selected.id);
  const bulkLabel = gridAllowed ? t("staff.masks.grid.allowAll") : t("staff.masks.grid.denyAll");

  const forumHeader = (view: MatrixView, forumId: string, extra?: ReactNode) => (
    <th scope="row" className="matrix-forum">
      <span
        className="matrix-forum-name"
        style={{ paddingInlineStart: `${depthOf(view, forumId) * 1}rem` }}
      >
        {forumTitle(forumId)}
      </span>
      {extra}
    </th>
  );

  return (
    <Page
      id="masks"
      title={t("staff.masks.title")}
      description={t("staff.masks.intro")}
      actions={
        <Button
          variant="primary"
          icon={<IconPlus size={16} />}
          data-mask-new
          onClick={() => {
            setCreating(true);
            setCreateDraft(EMPTY_DRAFT);
          }}
        >
          {t("staff.masks.create.title")}
        </Button>
      }
    >
      <QueryState query={query} errorLabel={t("staff.masks.loadError")}>
        {(view) => (
          <>
            {view.enabled ? null : (
              <Notice tone="warning" data-matrix-disabled title={t("staff.masks.disabled")} />
            )}

            <div className="page-split">
              <Panel title={t("staff.masks.list.title")} flush data-mask-list>
                <Table
                  caption={t("staff.masks.list.title")}
                  rows={masks}
                  rowKey={(mask) => mask.id}
                  rowProps={(mask) => ({
                    "data-mask-row": mask.key,
                    className: mask.id === selected?.id ? "is-selected" : undefined,
                  })}
                  columns={[
                    {
                      id: "name",
                      header: t("staff.masks.name"),
                      primary: true,
                      cell: (mask) => (
                        <div className="stack stack-sm">
                          <span className="list-row-title">
                            {mask.title}{" "}
                            {mask.isSystem ? <Badge>{t("staff.groups.system")}</Badge> : null}
                          </span>
                          {mask.description === "" ? null : (
                            <span className="subtle">{mask.description}</span>
                          )}
                        </div>
                      ),
                    },
                    {
                      id: "key",
                      header: t("staff.masks.key"),
                      cell: (mask) => <code>{mask.key}</code>,
                    },
                    {
                      id: "groups",
                      header: t("staff.masks.groups.count"),
                      align: "end",
                      cell: (mask) => mask.groupIds.length,
                    },
                    {
                      id: "actions",
                      header: t("staff.masks.actions"),
                      align: "end",
                      width: "3rem",
                      cell: (mask) => (
                        <IconButton
                          size="sm"
                          label={t("staff.masks.edit")}
                          data-mask-edit={mask.key}
                          onClick={() => {
                            setSelectedId(mask.id);
                            setCreating(false);
                          }}
                        >
                          <IconEdit size={16} />
                        </IconButton>
                      ),
                    },
                  ]}
                />
              </Panel>

              {creating || selected === null ? (
                <Panel
                  title={t("staff.masks.create.title")}
                  data-mask-create
                  actions={
                    selected === null ? undefined : (
                      <IconButton
                        size="sm"
                        label={t("staff.nav.close")}
                        onClick={() => setCreating(false)}
                      >
                        <IconClose size={16} />
                      </IconButton>
                    )
                  }
                >
                  <div className="stack">
                    <Field label={t("staff.masks.key")}>
                      {({ id }) => (
                        <TextInput
                          id={id}
                          data-mask-create-field="key"
                          value={createDraft.key}
                          onChange={(event) =>
                            setCreateDraft((current) => ({ ...current, key: event.target.value }))
                          }
                        />
                      )}
                    </Field>
                    <Field label={t("staff.masks.name")}>
                      {({ id }) => (
                        <TextInput
                          id={id}
                          data-mask-create-field="title"
                          value={createDraft.title}
                          onChange={(event) =>
                            setCreateDraft((current) => ({ ...current, title: event.target.value }))
                          }
                        />
                      )}
                    </Field>
                    <Field label={t("staff.masks.description")}>
                      {({ id }) => (
                        <TextInput
                          id={id}
                          data-mask-create-field="description"
                          value={createDraft.description}
                          onChange={(event) =>
                            setCreateDraft((current) => ({
                              ...current,
                              description: event.target.value,
                            }))
                          }
                        />
                      )}
                    </Field>
                    <FormActions>
                      <Button
                        variant="primary"
                        data-mask-create-submit
                        disabled={save.isPending}
                        onClick={() =>
                          save.mutate(
                            {
                              action: "save",
                              key: createDraft.key,
                              title: createDraft.title,
                              description: createDraft.description,
                              displayOrder: Number(createDraft.displayOrder),
                            },
                            { onSuccess: () => setCreating(false) },
                          )
                        }
                      >
                        {t("staff.masks.create.submit")}
                      </Button>
                    </FormActions>
                  </div>
                </Panel>
              ) : (
                <Panel
                  data-mask-editor={selected.key}
                  title={t("staff.masks.editor.title", { mask: selected.title })}
                  description={<code>{selected.key}</code>}
                >
                  <div className="stack">
                    <Field label={t("staff.masks.name")}>
                      {({ id }) => (
                        <TextInput
                          id={id}
                          data-mask-edit-field="title"
                          value={editDraft.title}
                          onChange={(event) =>
                            setEditDraft((current) => ({ ...current, title: event.target.value }))
                          }
                        />
                      )}
                    </Field>
                    <Field label={t("staff.masks.description")}>
                      {({ id }) => (
                        <TextInput
                          id={id}
                          data-mask-edit-field="description"
                          value={editDraft.description}
                          onChange={(event) =>
                            setEditDraft((current) => ({
                              ...current,
                              description: event.target.value,
                            }))
                          }
                        />
                      )}
                    </Field>
                    <fieldset className="field field-group">
                      <legend className="field-label">{t("staff.masks.groups.title")}</legend>
                      <div className="check-grid">
                        {view.groups.map((group) => (
                          <Checkbox
                            key={group.id}
                            label={group.title}
                            data-mask-link={`${group.id}:${selected.key}`}
                            checked={selected.groupIds.includes(group.id)}
                            onChange={(event) =>
                              save.mutate({
                                action: "link",
                                groupId: group.id,
                                maskId: selected.id,
                                linked: event.target.checked,
                              })
                            }
                          />
                        ))}
                      </div>
                    </fieldset>
                    <div className="form-actions-bar form-actions-split">
                      <Button
                        variant="danger"
                        icon={<IconTrash size={16} />}
                        data-mask-delete
                        disabled={save.isPending || selected.isSystem}
                        onClick={() => setConfirmDelete(true)}
                      >
                        {t("staff.masks.delete")}
                      </Button>
                      <Button
                        variant="primary"
                        data-mask-save
                        disabled={save.isPending}
                        onClick={() =>
                          save.mutate({
                            action: "save",
                            id: selected.id,
                            key: selected.key,
                            title: editDraft.title,
                            description: editDraft.description,
                            displayOrder: selected.displayOrder,
                          })
                        }
                      >
                        {t("staff.masks.save")}
                      </Button>
                    </div>
                  </div>
                  <ConfirmDialog
                    open={confirmDelete}
                    titleKey="staff.masks.confirmDelete.title"
                    bodyKey="staff.masks.confirmDelete.body"
                    confirmLabelKey="staff.masks.delete"
                    tone="danger"
                    busy={save.isPending}
                    onCancel={() => setConfirmDelete(false)}
                    onConfirm={() => {
                      setConfirmDelete(false);
                      save.mutate(
                        { action: "delete", id: selected.id },
                        { onSuccess: () => setSelectedId(null) },
                      );
                    }}
                  />
                </Panel>
              )}
            </div>

            {selected === null ? null : (
              <Panel
                flush
                title={t("staff.masks.matrix.titleFor", { mask: selected.title })}
                description={
                  <>
                    <span data-masks-member-note>{t("staff.masks.memberRevocationNote")}</span>{" "}
                    <span data-masks-guest-note>{t("staff.masks.guestRevocationNote")}</span>
                  </>
                }
              >
                <div className="matrix-scroll" data-matrix-scroll>
                  <table className="matrix" data-mask-matrix={selected.key}>
                    <thead>
                      <tr>
                        <th scope="col">{t("staff.masks.forum")}</th>
                        {view.actions.map((action) => (
                          <th key={action} scope="col" className="matrix-col">
                            {actionLabel(t, action)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {view.forums.map((forum) => {
                        const row = selectedRows.find(
                          (candidate) => candidate.forumId === forum.id,
                        );
                        return (
                          <tr key={forum.id} data-matrix-row={forum.id}>
                            {forumHeader(
                              view,
                              forum.id,
                              row?.inherits === true ? (
                                <Badge data-matrix-inherits={`${forum.id}:${selected.key}`}>
                                  {t("staff.masks.inherits")}
                                </Badge>
                              ) : null,
                            )}
                            {view.actions.map((action) => {
                              const allowed =
                                row !== undefined &&
                                (row.effectiveActions & (view.actionBits[action] ?? 0)) !== 0;
                              const label = `${forumTitle(forum.id)}: ${actionLabel(t, action)}`;
                              return (
                                <td
                                  key={action}
                                  data-label={actionLabel(t, action)}
                                  className="matrix-cell"
                                >
                                  <input
                                    type="checkbox"
                                    aria-label={label}
                                    title={
                                      allowed ? t("staff.masks.allowed") : t("staff.masks.denied")
                                    }
                                    data-matrix-cell={`${forum.id}:${selected.key}:${action}`}
                                    data-allowed={allowed}
                                    data-inherited={row?.inherits === true}
                                    checked={allowed}
                                    disabled={!view.enabled}
                                    onChange={() =>
                                      save.mutate({
                                        action: "cell",
                                        forumId: forum.id,
                                        maskId: selected.id,
                                        permissionAction: action,
                                        allowed: !allowed,
                                      })
                                    }
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}

            <Panel
              flush
              title={t("staff.masks.grid.title")}
              description={t("staff.masks.grid.intro")}
            >
              <div className="toolbar">
                <div className="toolbar-filters">
                  <Field label={t("staff.masks.bulk.action")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        data-grid-action
                        value={gridAction}
                        onChange={(event) => setGridAction(event.target.value)}
                      >
                        {view.actions.map((action) => (
                          <option key={action} value={action}>
                            {actionLabel(t, action)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t("staff.masks.grid.scope")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        data-grid-scope
                        value={gridScope}
                        onChange={(event) => setGridScope(event.target.value)}
                      >
                        {view.forums.map((forum) => (
                          <option key={forum.id} value={forum.id}>
                            {forumTitle(forum.id)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t("staff.masks.grid.bulkValue")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        data-grid-bulk-value
                        value={gridAllowed ? "allow" : "deny"}
                        onChange={(event) => setGridAllowed(event.target.value === "allow")}
                      >
                        <option value="allow">{t("staff.masks.allowed")}</option>
                        <option value="deny">{t("staff.masks.denied")}</option>
                      </Select>
                    )}
                  </Field>
                </div>
              </div>
              <div className="matrix-scroll" data-matrix-scroll>
                <table className="matrix" data-mask-grid>
                  <thead>
                    <tr>
                      <th scope="col">{t("staff.masks.forum")}</th>
                      {view.masks.map((mask) => (
                        <th key={mask.id} scope="col" className="matrix-col">
                          <span className="matrix-col-label">{mask.title}</span>
                          <button
                            type="button"
                            className="matrix-bulk"
                            title={t("staff.masks.grid.bulkColumnHint", {
                              forum: forumTitle(gridScope),
                            })}
                            data-grid-column-bulk={mask.key}
                            disabled={gridScope === "" || !view.enabled}
                            onClick={() =>
                              save.mutate({
                                action: "bulk",
                                forumId: gridScope,
                                maskId: mask.id,
                                permissionAction: gridAction,
                                allowed: gridAllowed,
                              })
                            }
                          >
                            {bulkLabel}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {view.forums.map((forum) => (
                      <tr key={forum.id} data-grid-row={forum.id}>
                        {forumHeader(
                          view,
                          forum.id,
                          <button
                            type="button"
                            className="matrix-bulk"
                            data-grid-row-bulk={forum.id}
                            disabled={!view.enabled}
                            onClick={() =>
                              save.mutate({
                                action: "bulk",
                                forumId: forum.id,
                                permissionAction: gridAction,
                                allowed: gridAllowed,
                              })
                            }
                          >
                            {bulkLabel}
                          </button>,
                        )}
                        {view.masks.map((mask) => {
                          const row = view.rows.find(
                            (candidate) =>
                              candidate.forumId === forum.id && candidate.maskId === mask.id,
                          );
                          const allowed =
                            row !== undefined &&
                            (row.effectiveActions & (view.actionBits[gridAction] ?? 0)) !== 0;
                          return (
                            <td key={mask.id} data-label={mask.title} className="matrix-cell">
                              <input
                                type="checkbox"
                                aria-label={`${forumTitle(forum.id)}: ${mask.title}`}
                                data-grid-cell={`${forum.id}:${mask.key}:${gridAction}`}
                                data-grid-allowed={allowed}
                                checked={allowed}
                                disabled={!view.enabled}
                                onChange={() =>
                                  save.mutate({
                                    action: "cell",
                                    forumId: forum.id,
                                    maskId: mask.id,
                                    permissionAction: gridAction,
                                    allowed: !allowed,
                                  })
                                }
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}
      </QueryState>
    </Page>
  );
}
