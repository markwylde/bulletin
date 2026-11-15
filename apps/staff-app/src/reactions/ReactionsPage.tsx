import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Field,
  IconArrowDown,
  IconArrowUp,
  IconButton,
  IconEdit,
  IconPlus,
  IconTrash,
  MenuItem,
  Page,
  Panel,
  QueryState,
  RowActions,
  Select,
  Switch,
  Table,
  TextInput,
} from "../ui/index.ts";

interface ReactionView {
  readonly id: string;
  readonly key: string;
  readonly icon: string;
  readonly labelKey: string;
  readonly weight: -1 | 0 | 1;
  readonly position: number;
  readonly enabled: boolean;
}

interface ReactionsView {
  readonly reactions: readonly ReactionView[];
}

/** The shipped reaction labels; the server validates the same list (ADR 0013). */
const LABEL_KEYS = [
  "reaction.label.like",
  "reaction.label.thanks",
  "reaction.label.love",
  "reaction.label.laugh",
  "reaction.label.wow",
  "reaction.label.sad",
  "reaction.label.confused",
  "reaction.label.angry",
] as const;

const WEIGHTS = [-1, 0, 1] as const;

interface Draft {
  readonly id: string | null;
  readonly key: string;
  readonly icon: string;
  readonly labelKey: string;
  readonly weight: -1 | 0 | 1;
  readonly position: string;
  readonly enabled: boolean;
}

const EMPTY: Draft = {
  id: null,
  key: "",
  icon: "",
  labelKey: LABEL_KEYS[0],
  weight: 0,
  position: "0",
  enabled: true,
};

function parseWeight(value: string): -1 | 0 | 1 {
  const parsed = Number(value);
  return parsed === -1 || parsed === 1 ? parsed : 0;
}

export function ReactionsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const query = useQuery({
    queryKey: ["staff", "reactions"],
    queryFn: () => apiGet<ReactionsView>("/api/staff/reactions"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/reactions", body),
    onSuccess: (_data, body) => {
      toast.pushToast({ messageKey: "staff.reactions.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "reactions"] });

      if (body.action === "save") {
        setDraft(EMPTY);
      }
    },
    onError: (error: unknown, body) => {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "duplicate_key") {
        toast.pushToast({ messageKey: "staff.reactions.duplicate", tone: "error" });
      } else if (code === "in_use") {
        toast.pushToast({ messageKey: "staff.reactions.inUse", tone: "error" });
      } else if (code === "invalid") {
        toast.pushToast({ messageKey: "staff.reactions.invalid", tone: "error" });
      } else {
        toast.pushToast({ messageKey: "staff.reactions.saveError", tone: "error" });
      }

      if (body.action === "delete" && code === "in_use") {
        void queryClient.invalidateQueries({ queryKey: ["staff", "reactions"] });
      }
    },
  });

  const selectReaction = (reaction: ReactionView): void => {
    setDraft({
      id: reaction.id,
      key: reaction.key,
      icon: reaction.icon,
      labelKey: reaction.labelKey,
      weight: reaction.weight,
      position: String(reaction.position),
      enabled: reaction.enabled,
    });
  };

  const canSave =
    draft.key.trim() !== "" &&
    draft.icon.trim() !== "" &&
    Number.isInteger(Number(draft.position)) &&
    Number(draft.position) >= 0;

  return (
    <Page
      id="reactions"
      title={t("staff.reactions.title")}
      description={t("staff.reactions.intro")}
      actions={
        query.isSuccess ? (
          <Button
            variant="primary"
            icon={<IconPlus size={16} />}
            data-reaction-new
            onClick={() =>
              setDraft({
                ...EMPTY,
                position: String(query.data.reactions.length),
              })
            }
          >
            {t("staff.reactions.new")}
          </Button>
        ) : undefined
      }
    >
      <QueryState query={query} errorLabel={t("staff.reactions.loadError")}>
        {(data) => (
          <div className="page-split">
            <Panel flush title={t("staff.reactions.list.title")}>
              <Table
                caption={t("staff.reactions.list.title")}
                rows={data.reactions}
                rowKey={(reaction) => reaction.id}
                rowProps={(reaction) => ({
                  "data-reaction-row": reaction.id,
                  className: reaction.id === draft.id ? "is-selected" : undefined,
                })}
                columns={[
                  {
                    id: "reaction",
                    header: t("staff.reactions.label"),
                    primary: true,
                    cell: (reaction) => (
                      <span className="cluster">
                        <span className="reaction-icon" aria-hidden="true">
                          {reaction.icon}
                        </span>
                        <span className="list-row-title">{t(reaction.labelKey)}</span>
                        {reaction.enabled ? null : <Badge>{t("staff.reactions.enabled.no")}</Badge>}
                      </span>
                    ),
                  },
                  {
                    id: "key",
                    header: t("staff.reactions.key"),
                    cell: (reaction) => <code>{reaction.key}</code>,
                  },
                  {
                    id: "weight",
                    header: t("staff.reactions.weight"),
                    align: "end",
                    cell: (reaction) => (
                      <Badge
                        tone={
                          reaction.weight > 0
                            ? "success"
                            : reaction.weight < 0
                              ? "danger"
                              : "neutral"
                        }
                      >
                        {reaction.weight > 0 ? "+1" : String(reaction.weight)}
                      </Badge>
                    ),
                  },
                  {
                    id: "actions",
                    header: t("staff.reactions.actions"),
                    align: "end",
                    width: "5.5rem",
                    cell: (reaction) => {
                      const index = data.reactions.indexOf(reaction);

                      return (
                        <span className="cluster cluster-end">
                          <IconButton
                            size="sm"
                            label={t("staff.reactions.edit")}
                            data-reaction-edit={reaction.id}
                            onClick={() => selectReaction(reaction)}
                          >
                            <IconEdit size={16} />
                          </IconButton>
                          <RowActions label={t("staff.rowActions")}>
                            <MenuItem
                              icon={<IconArrowUp size={16} />}
                              data-reaction-move={reaction.id}
                              data-direction="up"
                              disabled={mutate.isPending || index === 0}
                              onClick={() =>
                                mutate.mutate({ action: "move", id: reaction.id, direction: "up" })
                              }
                            >
                              {t("staff.reactions.moveUp")}
                            </MenuItem>
                            <MenuItem
                              icon={<IconArrowDown size={16} />}
                              data-reaction-move={reaction.id}
                              data-direction="down"
                              disabled={mutate.isPending || index === data.reactions.length - 1}
                              onClick={() =>
                                mutate.mutate({
                                  action: "move",
                                  id: reaction.id,
                                  direction: "down",
                                })
                              }
                            >
                              {t("staff.reactions.moveDown")}
                            </MenuItem>
                          </RowActions>
                        </span>
                      );
                    },
                  },
                ]}
              />
            </Panel>

            <Panel
              data-reaction-editor
              title={
                draft.id === null ? t("staff.reactions.new") : t("staff.reactions.editor.title")
              }
              description={t("staff.reactions.hint")}
            >
              <div className="stack">
                <div className="form-grid">
                  <Field label={t("staff.reactions.key")}>
                    {({ id }) => (
                      <TextInput
                        id={id}
                        data-reaction-key
                        value={draft.key}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, key: event.target.value }))
                        }
                      />
                    )}
                  </Field>
                  <Field label={t("staff.reactions.icon")}>
                    {({ id }) => (
                      <TextInput
                        id={id}
                        data-reaction-icon
                        maxLength={32}
                        value={draft.icon}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, icon: event.target.value }))
                        }
                      />
                    )}
                  </Field>
                </div>
                <Field label={t("staff.reactions.label")}>
                  {({ id }) => (
                    <Select
                      id={id}
                      data-reaction-label
                      value={draft.labelKey}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, labelKey: event.target.value }))
                      }
                    >
                      {LABEL_KEYS.map((key) => (
                        <option key={key} value={key}>
                          {t(key)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <div className="form-grid">
                  <Field label={t("staff.reactions.weight")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        data-reaction-weight
                        value={String(draft.weight)}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            weight: parseWeight(event.target.value),
                          }))
                        }
                      >
                        {WEIGHTS.map((weight) => (
                          <option key={weight} value={String(weight)}>
                            {weight > 0 ? "+1" : String(weight)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t("staff.reactions.order")}>
                    {({ id }) => (
                      <TextInput
                        id={id}
                        type="number"
                        min={0}
                        data-reaction-position
                        value={draft.position}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, position: event.target.value }))
                        }
                      />
                    )}
                  </Field>
                </div>
                <Switch
                  data-reaction-enabled
                  label={t("staff.reactions.enabled")}
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                <div className="form-actions-bar form-actions-split">
                  {draft.id === null ? (
                    <span />
                  ) : (
                    <Button
                      variant="danger"
                      icon={<IconTrash size={16} />}
                      data-reaction-delete
                      disabled={mutate.isPending}
                      onClick={() => setConfirmDelete(true)}
                    >
                      {t("staff.reactions.delete")}
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    data-reaction-save
                    disabled={mutate.isPending || !canSave}
                    onClick={() =>
                      mutate.mutate({
                        action: "save",
                        reaction: {
                          ...(draft.id === null ? {} : { id: draft.id }),
                          key: draft.key,
                          icon: draft.icon,
                          labelKey: draft.labelKey,
                          weight: draft.weight,
                          position: Number(draft.position),
                          enabled: draft.enabled,
                        },
                      })
                    }
                  >
                    {t("staff.reactions.save")}
                  </Button>
                </div>
              </div>
              <ConfirmDialog
                open={confirmDelete}
                titleKey="staff.reactions.deleteTitle"
                bodyKey="staff.reactions.deleteBody"
                confirmLabelKey="staff.reactions.delete"
                tone="danger"
                busy={mutate.isPending}
                onConfirm={() => {
                  setConfirmDelete(false);

                  if (draft.id !== null) {
                    mutate.mutate({ action: "delete", id: draft.id });
                  }
                }}
                onCancel={() => setConfirmDelete(false)}
              />
            </Panel>
          </div>
        )}
      </QueryState>
    </Page>
  );
}
