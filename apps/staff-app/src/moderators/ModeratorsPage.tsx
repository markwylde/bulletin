import { MODERATOR_POWERS, type ModeratorPower } from "@bulletin/domain/permissions";
import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormActions,
  IconButton,
  IconEdit,
  IconTrash,
  MenuItem,
  Notice,
  Page,
  Panel,
  QueryState,
  RowActions,
  Select,
  Switch,
  Table,
  TextInput,
} from "../ui/index.ts";

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
  readonly forums: ReadonlyArray<{ id: string; parentId: string | null }>;
  readonly powers: readonly ModeratorPower[];
}

const POWER_LABELS: Readonly<Record<ModeratorPower, { readonly labelKey: string }>> = {
  edit: { labelKey: "staff.groups.power.edit" },
  soft_delete: { labelKey: "staff.groups.power.soft_delete" },
  hard_delete: { labelKey: "staff.groups.power.hard_delete" },
  restore: { labelKey: "staff.groups.power.restore" },
  move: { labelKey: "staff.groups.power.move" },
  merge: { labelKey: "staff.groups.power.merge" },
  split: { labelKey: "staff.groups.power.split" },
  pin: { labelKey: "staff.groups.power.pin" },
  lock: { labelKey: "staff.groups.power.lock" },
  approve: { labelKey: "staff.groups.power.approve" },
  see_unapproved: { labelKey: "staff.groups.power.see_unapproved" },
  see_deleted: { labelKey: "staff.groups.power.see_deleted" },
  view_ips: { labelKey: "staff.groups.power.view_ips" },
  warn: { labelKey: "staff.groups.power.warn" },
  view_edit_history: { labelKey: "staff.groups.power.view_edit_history" },
  use_multimod: { labelKey: "staff.groups.power.use_multimod" },
};

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
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedMemberName, setSelectedMemberName] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const forumTitles = useQuery({
    queryKey: ["staff", "forums"],
    queryFn: () => apiGet<{ forums: Array<{ id: string; title: string }> }>("/api/staff/forums"),
  });
  const query = useQuery({
    queryKey: ["staff", "moderators"],
    queryFn: () => apiGet<ModeratorView>("/api/staff/moderators"),
  });
  const memberQuery = useInfiniteQuery({
    queryKey: ["staff", "moderator-members", memberSearch],
    queryFn: ({ pageParam }) =>
      apiGet<{
        members: Array<{ id: string; displayName: string }>;
        nextOffset: number | null;
      }>(
        `/api/staff/moderators/members?query=${encodeURIComponent(
          memberSearch,
        )}&offset=${pageParam}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    enabled: draft.assigneeKind === "member",
  });
  const memberOptions = memberQuery.data?.pages.flatMap((page) => page.members) ?? [];
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

  const groupOptions =
    query.data?.groups.map((group) => ({ id: group.id, label: group.title })) ?? [];

  const selectAssignment = (assignment: ModeratorView["assignments"][number]): void => {
    setDraft({
      id: assignment.id,
      forumId: assignment.forumId,
      assigneeKind: assignment.memberId === null ? "group" : "member",
      assigneeId: assignment.memberId ?? assignment.groupId ?? "",
      powers: assignment.powers,
      thisForumOnly: assignment.thisForumOnly,
    });
    setSelectedMemberName(assignment.memberName);
    setMemberSearch("");
  };

  const forumTitle = (id: string): string =>
    forumTitles.data?.forums.find((forum) => forum.id === id)?.title ?? `#${id}`;
  const powerLabel = (power: ModeratorPower): string => t(POWER_LABELS[power].labelKey);
  const confirmAssignment = query.data?.assignments.find((item) => item.id === confirmId);

  return (
    <Page
      id="moderators"
      title={t("staff.moderators.title")}
      description={t("staff.moderators.intro")}
    >
      <QueryState query={query} errorLabel={t("staff.moderators.loadError")}>
        {(data) => (
          <>
            {data.forums.length === 0 ? (
              <Notice tone="neutral" title={t("staff.moderators.noForums")} />
            ) : null}
            <Panel flush title={t("staff.moderators.list.title")}>
              <Table
                caption={t("staff.moderators.list.title")}
                rows={data.assignments}
                rowKey={(assignment) => assignment.id}
                rowProps={(assignment) => ({
                  "data-moderator-row": assignment.id,
                  className: assignment.id === draft.id ? "is-selected" : undefined,
                })}
                empty={<EmptyState title={t("staff.moderators.empty")} />}
                columns={[
                  {
                    id: "forum",
                    header: t("staff.moderators.forum"),
                    primary: true,
                    cell: (assignment) => forumTitle(assignment.forumId),
                  },
                  {
                    id: "assignee",
                    header: t("staff.moderators.assignee"),
                    cell: (assignment) => (
                      <span className="cluster">
                        <span>
                          {assignment.memberName ??
                            query.data?.groups.find((group) => group.id === assignment.groupId)
                              ?.title ??
                            assignment.groupKey ??
                            ""}
                        </span>
                        <Badge>
                          {assignment.memberId === null
                            ? t("staff.moderators.group")
                            : t("staff.moderators.member")}
                        </Badge>
                      </span>
                    ),
                  },
                  {
                    id: "powers",
                    header: t("staff.moderators.powers"),
                    cell: (assignment) => (
                      <span className="subtle">
                        {t("staff.moderators.powerCount", { count: assignment.powers.length })}
                      </span>
                    ),
                  },
                  {
                    id: "scope",
                    header: t("staff.moderators.scope"),
                    cell: (assignment) =>
                      assignment.thisForumOnly
                        ? t("staff.moderators.thisForumOnly")
                        : t("staff.moderators.inherited"),
                  },
                  {
                    id: "actions",
                    header: t("staff.rowActions"),
                    align: "end",
                    width: "5.5rem",
                    cell: (assignment) => (
                      <span className="cluster cluster-end">
                        <IconButton
                          size="sm"
                          label={t("staff.moderators.edit")}
                          data-moderator-edit={assignment.id}
                          onClick={() => selectAssignment(assignment)}
                        >
                          <IconEdit size={16} />
                        </IconButton>
                        <RowActions label={t("staff.rowActions")}>
                          <MenuItem
                            tone="danger"
                            icon={<IconTrash size={16} />}
                            data-moderator-remove={assignment.id}
                            onClick={() => setConfirmId(assignment.id)}
                          >
                            {t("staff.moderators.delete")}
                          </MenuItem>
                        </RowActions>
                      </span>
                    ),
                  },
                ]}
              />
            </Panel>

            <Panel
              title={
                draft.id === null
                  ? t("staff.moderators.editor.title")
                  : t("staff.moderators.editor.editTitle")
              }
              data-moderator-editor
            >
              <div className="stack">
                <div className="form-grid">
                  <Field label={t("staff.moderators.forum")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        data-moderator-forum
                        value={draft.forumId}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, forumId: event.target.value }))
                        }
                      >
                        {data.forums.map((forum) => (
                          <option key={forum.id} value={forum.id}>
                            {forumTitle(forum.id)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t("staff.moderators.assigneeKind")}>
                    {({ id }) => (
                      <Select
                        id={id}
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
                      </Select>
                    )}
                  </Field>
                </div>
                {draft.assigneeKind === "member" ? (
                  <div className="form-grid">
                    <Field label={t("staff.moderators.searchMembers")}>
                      {({ id }) => (
                        <TextInput
                          id={id}
                          type="search"
                          data-moderator-member-search
                          value={memberSearch}
                          onChange={(event) => {
                            setMemberSearch(event.target.value);
                            setSelectedMemberName(null);
                          }}
                        />
                      )}
                    </Field>
                    <Field label={t("staff.moderators.assignee")}>
                      {({ id }) => (
                        <Select
                          id={id}
                          data-moderator-assignee
                          value={draft.assigneeId}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDraft((current) => ({ ...current, assigneeId: value }));
                            setSelectedMemberName(
                              memberOptions.find((member) => member.id === value)?.displayName ??
                                selectedMemberName,
                            );
                          }}
                        >
                          <option value="">{t("staff.moderators.assignee.none")}</option>
                          {draft.assigneeId !== "" &&
                          !memberOptions.some((member) => member.id === draft.assigneeId) ? (
                            <option value={draft.assigneeId}>
                              {selectedMemberName ?? draft.assigneeId}
                            </option>
                          ) : null}
                          {memberOptions.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.displayName}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    {memberQuery.hasNextPage ? (
                      <div>
                        <Button
                          size="sm"
                          variant="ghost"
                          data-moderator-member-more
                          disabled={memberQuery.isFetchingNextPage}
                          onClick={() => void memberQuery.fetchNextPage()}
                        >
                          {t("staff.moderators.loadMore")}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <Field label={t("staff.moderators.assignee")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        data-moderator-assignee
                        value={draft.assigneeId}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, assigneeId: event.target.value }))
                        }
                      >
                        <option value="">{t("staff.moderators.assignee.none")}</option>
                        {groupOptions.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                <Switch
                  data-moderator-scope
                  label={t("staff.moderators.thisForumOnly")}
                  checked={draft.thisForumOnly}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, thisForumOnly: event.target.checked }))
                  }
                />

                <fieldset className="field-group">
                  <legend>{t("staff.moderators.powers")}</legend>
                  <div className="check-grid">
                    {MODERATOR_POWERS.map((power) => (
                      <Checkbox
                        key={power}
                        label={powerLabel(power)}
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
                    ))}
                  </div>
                </fieldset>

                <FormActions>
                  {draft.id === null ? null : (
                    <Button variant="ghost" onClick={() => setDraft(EMPTY)}>
                      {t("staff.moderators.cancel")}
                    </Button>
                  )}
                  <Button
                    variant="primary"
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
                  </Button>
                </FormActions>
              </div>
            </Panel>
          </>
        )}
      </QueryState>

      <ConfirmDialog
        open={confirmId !== null}
        titleKey="staff.moderators.confirmDelete.title"
        bodyKey="staff.moderators.confirmDelete.body"
        confirmLabelKey="staff.moderators.delete"
        tone="danger"
        busy={save.isPending}
        onCancel={() => setConfirmId(null)}
        onConfirm={() => {
          const target = confirmAssignment;
          setConfirmId(null);

          if (target !== undefined) {
            save.mutate({ action: "delete", id: target.id });

            if (draft.id === target.id) {
              setDraft(EMPTY);
            }
          }
        }}
      />
    </Page>
  );
}
