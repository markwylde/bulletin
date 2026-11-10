import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface GroupView {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly isSystem: boolean;
  readonly displayOrder: number;
  readonly nameColour: string | null;
  readonly icon: string | null;
  readonly memberCount: number;
  readonly primaryMemberCount: number;
}

interface Draft {
  readonly key: string;
  readonly title: string;
  readonly nameColour: string;
  readonly icon: string;
  readonly displayOrder: string;
}

const EMPTY_DRAFT: Draft = {
  key: "",
  title: "",
  nameColour: "#c0a000",
  icon: "",
  displayOrder: "100",
};

function draftFrom(group: GroupView): Draft {
  return {
    key: group.key,
    title: group.title,
    nameColour: group.nameColour ?? "",
    icon: group.icon ?? "",
    displayOrder: String(group.displayOrder),
  };
}

function payloadFrom(draft: Draft): Record<string, unknown> {
  return {
    key: draft.key,
    title: draft.title,
    nameColour: draft.nameColour.trim() === "" ? null : draft.nameColour,
    icon: draft.icon.trim() === "" ? null : draft.icon,
    displayOrder: Number(draft.displayOrder),
  };
}

export function GroupsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [createDraft, setCreateDraft] = useState<Draft>(EMPTY_DRAFT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [replacementId, setReplacementId] = useState("");
  const groupsQuery = useQuery({
    queryKey: ["staff", "groups"],
    queryFn: () => apiGet<{ groups: GroupView[] }>("/api/staff/groups"),
  });
  const groups = groupsQuery.data?.groups ?? [];
  const selected = groups.find((group) => group.id === selectedId) ?? null;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["staff", "groups"] });
  };

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/groups", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.groups.saved", tone: "success" });
      void refresh();
    },
    onError: () => toast.pushToast({ messageKey: "staff.groups.saveError", tone: "error" }),
  });

  const selectGroup = (group: GroupView): void => {
    setSelectedId(group.id);
    setEditDraft(draftFrom(group));
    setReplacementId("");
  };

  const move = (group: GroupView, delta: -1 | 1): void => {
    const ids = groups.map((candidate) => candidate.id);
    const index = ids.indexOf(group.id);
    const target = index + delta;

    if (index < 0 || target < 0 || target >= ids.length) {
      return;
    }

    const [moved] = ids.splice(index, 1);

    if (moved === undefined) {
      return;
    }

    ids.splice(target, 0, moved);
    save.mutate({ action: "reorder", ids });
  };

  const columns: readonly DataTableColumn<GroupView>[] = [
    {
      id: "title",
      headerKey: "staff.groups.title",
      cell: (group) => (
        <span className="group-title-cell">
          {group.nameColour === null ? null : (
            <span
              className="group-swatch"
              style={{ backgroundColor: group.nameColour }}
              aria-hidden="true"
            />
          )}
          {group.title}
        </span>
      ),
      sortValue: (group) => group.title,
    },
    {
      id: "key",
      headerKey: "staff.groups.key",
      cell: (group) => <span className="log-action">{group.key}</span>,
      sortValue: (group) => group.key,
    },
    {
      id: "members",
      headerKey: "staff.groups.members",
      cell: (group) => group.memberCount,
      sortValue: (group) => group.memberCount,
      align: "end",
    },
    {
      id: "primary",
      headerKey: "staff.groups.primaryMembers",
      cell: (group) => group.primaryMemberCount,
      sortValue: (group) => group.primaryMemberCount,
      align: "end",
    },
    {
      id: "order",
      headerKey: "staff.groups.order",
      cell: (group) => group.displayOrder,
      sortValue: (group) => group.displayOrder,
      align: "end",
    },
  ];

  return (
    <div className="page" data-page="groups">
      <header className="page-header">
        <h1>{t("staff.groups.titlePage")}</h1>
        <p>{t("staff.groups.intro")}</p>
      </header>

      {groupsQuery.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {groupsQuery.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.groups.loadError")}</p>
          <button type="button" onClick={() => void groupsQuery.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {groupsQuery.isSuccess ? (
        <section className="admin-panel" aria-labelledby="groups-list-title">
          <h2 id="groups-list-title">{t("staff.groups.list.title")}</h2>
          <DataTable
            rows={groups}
            columns={columns}
            getRowId={(group) => group.key}
            getRowLabel={(group) => group.title}
            pageSize={20}
            captionKey="staff.groups.caption"
            emptyKey="staff.groups.empty"
            rowActions={(group) => (
              <>
                <button
                  type="button"
                  data-group-edit={group.key}
                  onClick={() => selectGroup(group)}
                >
                  {t("staff.groups.edit")}
                </button>
                <button
                  type="button"
                  data-group-up={group.key}
                  disabled={groups[0]?.id === group.id}
                  onClick={() => move(group, -1)}
                >
                  {t("staff.groups.moveUp")}
                </button>
                <button
                  type="button"
                  data-group-down={group.key}
                  disabled={groups[groups.length - 1]?.id === group.id}
                  onClick={() => move(group, 1)}
                >
                  {t("staff.groups.moveDown")}
                </button>
              </>
            )}
          />
        </section>
      ) : null}

      <section className="admin-panel" aria-labelledby="group-create-title">
        <h2 id="group-create-title">{t("staff.groups.create.title")}</h2>
        <div className="admin-form" data-group-create>
          <label>
            <span>{t("staff.groups.key")}</span>
            <input
              data-group-field="key"
              value={createDraft.key}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, key: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("staff.groups.title")}</span>
            <input
              data-group-field="title"
              value={createDraft.title}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, title: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("staff.groups.colour")}</span>
            <input
              data-group-field="colour"
              value={createDraft.nameColour}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, nameColour: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("staff.groups.order")}</span>
            <input
              data-group-field="order"
              type="number"
              value={createDraft.displayOrder}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, displayOrder: event.target.value }))
              }
            />
          </label>
          <button
            type="button"
            data-group-create-submit
            disabled={save.isPending}
            onClick={() => save.mutate({ action: "create", ...payloadFrom(createDraft) })}
          >
            {t("staff.groups.create.submit")}
          </button>
        </div>
      </section>

      {selected === null ? (
        <section className="admin-panel" data-group-editor="none">
          <p className="widget-muted">{t("staff.groups.choose")}</p>
        </section>
      ) : (
        <section className="admin-panel" data-group-editor={selected.key}>
          <h2>{t("staff.groups.editor.title", { group: selected.title })}</h2>
          <div className="admin-form">
            <label>
              <span>{t("staff.groups.title")}</span>
              <input
                data-group-edit-field="title"
                value={editDraft.title}
                onChange={(event) =>
                  setEditDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </label>
            <label>
              <span>{t("staff.groups.colour")}</span>
              <input
                data-group-edit-field="colour"
                value={editDraft.nameColour}
                onChange={(event) =>
                  setEditDraft((current) => ({ ...current, nameColour: event.target.value }))
                }
              />
            </label>
            <label>
              <span>{t("staff.groups.icon")}</span>
              <input
                data-group-edit-field="icon"
                value={editDraft.icon}
                onChange={(event) =>
                  setEditDraft((current) => ({ ...current, icon: event.target.value }))
                }
              />
            </label>
            <label>
              <span>{t("staff.groups.order")}</span>
              <input
                data-group-edit-field="order"
                type="number"
                value={editDraft.displayOrder}
                onChange={(event) =>
                  setEditDraft((current) => ({ ...current, displayOrder: event.target.value }))
                }
              />
            </label>
            <button
              type="button"
              data-group-save
              disabled={save.isPending}
              onClick={() =>
                save.mutate({ action: "update", id: selected.id, ...payloadFrom(editDraft) })
              }
            >
              {t("staff.groups.save")}
            </button>
          </div>

          <div className="admin-form">
            <label>
              <span>{t("staff.groups.replacement")}</span>
              <select
                data-group-replacement
                value={replacementId}
                onChange={(event) => setReplacementId(event.target.value)}
              >
                <option value="">{t("staff.groups.replacement.none")}</option>
                {groups
                  .filter((group) => group.id !== selected.id)
                  .map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.title}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              data-group-delete
              disabled={save.isPending || selected.isSystem}
              onClick={() =>
                save.mutate({
                  action: "delete",
                  id: selected.id,
                  replacementGroupId: replacementId === "" ? null : replacementId,
                })
              }
            >
              {t("staff.groups.delete")}
            </button>
            {selected.isSystem ? (
              <p className="widget-muted">{t("staff.groups.systemHint")}</p>
            ) : null}
            {selected.primaryMemberCount > 0 ? (
              <p className="widget-muted">{t("staff.groups.replacementHint")}</p>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}
