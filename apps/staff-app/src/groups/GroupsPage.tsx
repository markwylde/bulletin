import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Field,
  FormActions,
  IconArrowDown,
  IconArrowUp,
  IconButton,
  IconClose,
  IconEdit,
  IconPlus,
  IconTrash,
  MenuItem,
  Page,
  Panel,
  QueryState,
  RowActions,
  Select,
  Swatch,
  TextInput,
} from "../ui/index.ts";

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
    onError: (error) => {
      if (error instanceof ApiError && error.code === "group_in_use") {
        toast.pushToast({ messageKey: "staff.groups.deleteInUse", tone: "error" });
        return;
      }

      toast.pushToast({ messageKey: "staff.groups.saveError", tone: "error" });
    },
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

  const [confirmDelete, setConfirmDelete] = useState(false);

  const columns: readonly DataTableColumn<GroupView>[] = [
    {
      id: "title",
      primary: true,
      headerKey: "staff.groups.title",
      cell: (group) => (
        <span className="with-swatch">
          {group.nameColour === null ? null : <Swatch color={group.nameColour} />}
          <span className="truncate">{group.title}</span>
          {group.isSystem ? <Badge>{t("staff.groups.system")}</Badge> : null}
        </span>
      ),
      sortValue: (group) => group.title,
    },
    {
      id: "key",
      headerKey: "staff.groups.key",
      cell: (group) => <code>{group.key}</code>,
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

  const draftFields = (
    draft: Draft,
    setDraft: (update: (current: Draft) => Draft) => void,
    hook: "data-group-field" | "data-group-edit-field",
    withKey: boolean,
  ) => (
    <div className="form-grid">
      {withKey ? (
        <Field label={t("staff.groups.key")}>
          {({ id }) => (
            <TextInput
              id={id}
              {...{ [hook]: "key" }}
              value={draft.key}
              onChange={(event) => setDraft((current) => ({ ...current, key: event.target.value }))}
            />
          )}
        </Field>
      ) : null}
      <Field label={t("staff.groups.title")}>
        {({ id }) => (
          <TextInput
            id={id}
            {...{ [hook]: "title" }}
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          />
        )}
      </Field>
      <Field label={t("staff.groups.colour")}>
        {({ id }) => (
          <div className="with-swatch">
            {draft.nameColour.trim() === "" ? null : <Swatch color={draft.nameColour} />}
            <TextInput
              id={id}
              {...{ [hook]: "colour" }}
              value={draft.nameColour}
              onChange={(event) =>
                setDraft((current) => ({ ...current, nameColour: event.target.value }))
              }
            />
          </div>
        )}
      </Field>
      {withKey ? null : (
        <Field label={t("staff.groups.icon")}>
          {({ id }) => (
            <TextInput
              id={id}
              {...{ [hook]: "icon" }}
              value={draft.icon}
              onChange={(event) =>
                setDraft((current) => ({ ...current, icon: event.target.value }))
              }
            />
          )}
        </Field>
      )}
      <Field label={t("staff.groups.order")}>
        {({ id }) => (
          <TextInput
            id={id}
            type="number"
            {...{ [hook]: "order" }}
            value={draft.displayOrder}
            onChange={(event) =>
              setDraft((current) => ({ ...current, displayOrder: event.target.value }))
            }
          />
        )}
      </Field>
    </div>
  );

  return (
    <Page
      id="groups"
      title={t("staff.groups.titlePage")}
      description={t("staff.groups.intro")}
      actions={
        <Button
          variant="primary"
          icon={<IconPlus size={16} />}
          data-group-new
          onClick={() => {
            setSelectedId(null);
            setCreateDraft(EMPTY_DRAFT);
            document.querySelector<HTMLInputElement>('[data-group-field="key"]')?.focus();
          }}
        >
          {t("staff.groups.create.title")}
        </Button>
      }
    >
      <QueryState query={groupsQuery} errorLabel={t("staff.groups.loadError")}>
        {() => (
          <div className="stack">
            <Panel title={t("staff.groups.list.title")} flush>
              <DataTable
                rows={groups}
                columns={columns}
                getRowId={(group) => group.key}
                getRowLabel={(group) => group.title}
                pageSize={20}
                captionKey="staff.groups.caption"
                emptyKey="staff.groups.empty"
                rowClassName={(group) => (group.id === selectedId ? "is-selected" : undefined)}
                rowActions={(group) => (
                  <>
                    <IconButton
                      size="sm"
                      label={t("staff.groups.edit")}
                      data-group-edit={group.key}
                      onClick={() => selectGroup(group)}
                    >
                      <IconEdit size={16} />
                    </IconButton>
                    <RowActions label={t("staff.rowActions")}>
                      <MenuItem
                        icon={<IconArrowUp size={16} />}
                        data-group-up={group.key}
                        disabled={groups[0]?.id === group.id}
                        onClick={() => move(group, -1)}
                      >
                        {t("staff.groups.moveUp")}
                      </MenuItem>
                      <MenuItem
                        icon={<IconArrowDown size={16} />}
                        data-group-down={group.key}
                        disabled={groups[groups.length - 1]?.id === group.id}
                        onClick={() => move(group, 1)}
                      >
                        {t("staff.groups.moveDown")}
                      </MenuItem>
                    </RowActions>
                  </>
                )}
              />
            </Panel>

            {selected === null ? (
              <Panel
                title={t("staff.groups.create.title")}
                data-group-create
                data-group-editor="none"
              >
                <div className="stack">
                  {draftFields(createDraft, setCreateDraft, "data-group-field", true)}
                  <FormActions>
                    <Button
                      variant="primary"
                      data-group-create-submit
                      disabled={save.isPending}
                      onClick={() => save.mutate({ action: "create", ...payloadFrom(createDraft) })}
                    >
                      {t("staff.groups.create.submit")}
                    </Button>
                  </FormActions>
                </div>
              </Panel>
            ) : (
              <div className="stack" data-group-editor={selected.key}>
                <Panel
                  title={t("staff.groups.editor.title", { group: selected.title })}
                  description={<code>{selected.key}</code>}
                  actions={
                    <IconButton
                      size="sm"
                      label={t("staff.nav.close")}
                      onClick={() => setSelectedId(null)}
                    >
                      <IconClose size={16} />
                    </IconButton>
                  }
                >
                  <div className="stack">
                    {draftFields(editDraft, setEditDraft, "data-group-edit-field", false)}
                    <FormActions>
                      <Button
                        variant="primary"
                        data-group-save
                        disabled={save.isPending}
                        onClick={() =>
                          save.mutate({
                            action: "update",
                            id: selected.id,
                            ...payloadFrom(editDraft),
                          })
                        }
                      >
                        {t("staff.groups.save")}
                      </Button>
                    </FormActions>
                  </div>
                </Panel>
                <Panel title={t("staff.groups.delete")}>
                  <div className="stack">
                    {selected.isSystem ? (
                      <p className="muted">{t("staff.groups.systemHint")}</p>
                    ) : (
                      <>
                        <Field
                          label={t("staff.groups.replacement")}
                          description={
                            selected.primaryMemberCount > 0
                              ? t("staff.groups.replacementHint")
                              : undefined
                          }
                        >
                          {({ id, describedBy }) => (
                            <Select
                              id={id}
                              aria-describedby={describedBy}
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
                            </Select>
                          )}
                        </Field>
                        <div>
                          <Button
                            variant="danger"
                            icon={<IconTrash size={16} />}
                            data-group-delete
                            disabled={save.isPending}
                            onClick={() => setConfirmDelete(true)}
                          >
                            {t("staff.groups.delete")}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </Panel>
                <ConfirmDialog
                  open={confirmDelete}
                  titleKey="staff.groups.confirmDelete.title"
                  bodyKey="staff.groups.confirmDelete.body"
                  confirmLabelKey="staff.groups.delete"
                  tone="danger"
                  busy={save.isPending}
                  onCancel={() => setConfirmDelete(false)}
                  onConfirm={() => {
                    setConfirmDelete(false);
                    save.mutate(
                      {
                        action: "delete",
                        id: selected.id,
                        replacementGroupId: replacementId === "" ? null : replacementId,
                      },
                      { onSuccess: () => setSelectedId(null) },
                    );
                  }}
                />
              </div>
            )}
          </div>
        )}
      </QueryState>
    </Page>
  );
}
