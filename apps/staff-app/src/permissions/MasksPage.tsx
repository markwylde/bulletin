import { capabilityBitMask, FORUM_ACTIONS, type ForumAction } from "@bulletin/domain/permissions";
import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

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
  readonly actions: readonly ForumAction[];
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
} as const satisfies Readonly<Record<ForumAction, { labelKey: string }>>;

function actionLabelKey(action: ForumAction): string {
  return ACTION_LABELS[action].labelKey;
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
  const [createDraft, setCreateDraft] = useState<MaskDraft>(EMPTY_DRAFT);
  const [editDraft, setEditDraft] = useState<MaskDraft>(EMPTY_DRAFT);
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkAction, setBulkAction] = useState<ForumAction>("read");
  const [bulkAllowed, setBulkAllowed] = useState(true);
  const query = useQuery({
    queryKey: ["staff", "masks"],
    queryFn: () => apiGet<MatrixView>("/api/staff/masks"),
  });
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
    if (selected !== null) {
      setEditDraft(maskDraft(selected));
    }
  }, [selected]);

  const selectedRows =
    query.data === undefined || selected === null
      ? []
      : query.data.rows.filter((row) => row.maskId === selected.id);

  return (
    <div className="page" data-page="masks">
      <header className="page-header">
        <h1>{t("staff.masks.title")}</h1>
        <p>{t("staff.masks.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.masks.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess && !query.data.enabled ? (
        <p className="widget-muted" data-matrix-disabled>
          {t("staff.masks.disabled")}
        </p>
      ) : null}

      {query.isSuccess ? (
        <>
          <section className="admin-panel" data-mask-list aria-labelledby="mask-list-title">
            <h2 id="mask-list-title">{t("staff.masks.list.title")}</h2>
            <div className="matrix-scroll" data-matrix-scroll>
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th scope="col">{t("staff.masks.key")}</th>
                    <th scope="col">{t("staff.masks.name")}</th>
                    <th scope="col">{t("staff.masks.description")}</th>
                    <th scope="col">{t("staff.masks.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {masks.map((mask) => (
                    <tr key={mask.id} data-mask-row={mask.key}>
                      <th scope="row">
                        <span className="log-action">{mask.key}</span>
                      </th>
                      <td data-label={t("staff.masks.name")}>{mask.title}</td>
                      <td data-label={t("staff.masks.description")}>{mask.description}</td>
                      <td data-label={t("staff.masks.actions")}>
                        <button
                          type="button"
                          data-mask-edit={mask.key}
                          onClick={() => setSelectedId(mask.id)}
                        >
                          {t("staff.masks.edit")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="admin-panel" aria-labelledby="mask-create-title">
            <h2 id="mask-create-title">{t("staff.masks.create.title")}</h2>
            <div className="admin-form" data-mask-create>
              <label>
                <span>{t("staff.masks.key")}</span>
                <input
                  data-mask-create-field="key"
                  value={createDraft.key}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, key: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.masks.name")}</span>
                <input
                  data-mask-create-field="title"
                  value={createDraft.title}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, title: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.masks.description")}</span>
                <input
                  data-mask-create-field="description"
                  value={createDraft.description}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </label>
              <button
                type="button"
                data-mask-create-submit
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    action: "save",
                    key: createDraft.key,
                    title: createDraft.title,
                    description: createDraft.description,
                    displayOrder: Number(createDraft.displayOrder),
                  })
                }
              >
                {t("staff.masks.create.submit")}
              </button>
            </div>
          </section>

          {selected === null ? null : (
            <section className="admin-panel" data-mask-editor={selected.key}>
              <h2>{t("staff.masks.editor.title", { mask: selected.title })}</h2>
              <div className="admin-form">
                <label>
                  <span>{t("staff.masks.name")}</span>
                  <input
                    data-mask-edit-field="title"
                    value={editDraft.title}
                    onChange={(event) =>
                      setEditDraft((current) => ({ ...current, title: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.masks.description")}</span>
                  <input
                    data-mask-edit-field="description"
                    value={editDraft.description}
                    onChange={(event) =>
                      setEditDraft((current) => ({ ...current, description: event.target.value }))
                    }
                  />
                </label>
                <button
                  type="button"
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
                </button>
                <button
                  type="button"
                  data-mask-delete
                  disabled={save.isPending || selected.isSystem}
                  onClick={() => save.mutate({ action: "delete", id: selected.id })}
                >
                  {t("staff.masks.delete")}
                </button>
              </div>

              <h3>{t("staff.masks.groups.title")}</h3>
              <ul className="check-list">
                {query.data.groups.map((group) => (
                  <li key={group.id}>
                    <label>
                      <input
                        type="checkbox"
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
                      <span>{group.title}</span>
                    </label>
                  </li>
                ))}
              </ul>

              <h3>{t("staff.masks.bulk.title")}</h3>
              <div className="admin-form" data-bulk-toggle>
                <label>
                  <span>{t("staff.masks.bulk.category")}</span>
                  <select
                    data-bulk-category
                    value={bulkCategory}
                    onChange={(event) => setBulkCategory(event.target.value)}
                  >
                    {query.data.forums.map((forum) => (
                      <option key={forum.id} value={forum.id}>
                        {`#${forum.id}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("staff.masks.bulk.action")}</span>
                  <select
                    data-bulk-action
                    value={bulkAction}
                    onChange={(event) => setBulkAction(event.target.value as ForumAction)}
                  >
                    {FORUM_ACTIONS.map((action) => (
                      <option key={action} value={action}>
                        {t(actionLabelKey(action))}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    data-bulk-allowed
                    checked={bulkAllowed}
                    onChange={(event) => setBulkAllowed(event.target.checked)}
                  />
                  <span>{t("staff.masks.bulk.allow")}</span>
                </label>
                <button
                  type="button"
                  data-bulk-submit
                  disabled={save.isPending || bulkCategory === ""}
                  onClick={() =>
                    save.mutate({
                      action: "bulk",
                      categoryId: bulkCategory,
                      maskId: selected.id,
                      permissionAction: bulkAction,
                      allowed: bulkAllowed,
                    })
                  }
                >
                  {t("staff.masks.bulk.submit")}
                </button>
              </div>

              <h3>{t("staff.masks.matrix.title")}</h3>
              <div className="matrix-scroll" data-matrix-scroll>
                <table className="matrix-table" data-mask-matrix={selected.key}>
                  <thead>
                    <tr>
                      <th scope="col">{t("staff.masks.forum")}</th>
                      {query.data.actions.map((action) => (
                        <th key={action} scope="col">
                          {t(actionLabelKey(action))}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.forums.map((forum) => {
                      const row = selectedRows.find((candidate) => candidate.forumId === forum.id);
                      return (
                        <tr key={forum.id} data-matrix-row={forum.id}>
                          <th
                            scope="row"
                            style={{
                              paddingInlineStart: `${depthOf(query.data, forum.id) * 12 + 8}px`,
                            }}
                          >
                            {`#${forum.id}`}
                            {row?.inherits === true ? (
                              <span
                                className="section-detail"
                                data-matrix-inherits={`${forum.id}:${selected.key}`}
                              >
                                {t("staff.masks.inherits")}
                              </span>
                            ) : null}
                          </th>
                          {query.data.actions.map((action) => {
                            const allowed =
                              row !== undefined &&
                              (row.effectiveActions & capabilityBitMask(action)) !== 0;
                            return (
                              <td key={action} data-label={t(actionLabelKey(action))}>
                                <button
                                  type="button"
                                  className={allowed ? "matrix-toggle is-on" : "matrix-toggle"}
                                  data-matrix-cell={`${forum.id}:${selected.key}:${action}`}
                                  data-allowed={allowed}
                                  onClick={() =>
                                    save.mutate({
                                      action: "cell",
                                      forumId: forum.id,
                                      maskId: selected.id,
                                      permissionAction: action,
                                      allowed: !allowed,
                                    })
                                  }
                                >
                                  {allowed ? t("staff.masks.allowed") : t("staff.masks.denied")}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
