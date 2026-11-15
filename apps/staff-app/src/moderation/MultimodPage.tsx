import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormActions,
  IconButton,
  IconEdit,
  IconPlus,
  IconTrash,
  MenuItem,
  Page,
  Panel,
  RowActions,
  Select,
  Textarea,
  TextInput,
} from "../ui/index.ts";

interface ForumRecord {
  readonly id: string;
  readonly title: string;
  readonly type: string;
}

interface PrefixRecord {
  readonly id: string;
  readonly key: string;
  readonly labels: Readonly<Record<string, string | undefined>>;
}

interface ServiceMember {
  readonly id: string;
  readonly name: string | null;
}

type Step =
  | { readonly type: "move"; readonly forumId: string }
  | { readonly type: "lock"; readonly locked: boolean }
  | { readonly type: "pin"; readonly pinned: boolean }
  | { readonly type: "prefix"; readonly prefixId: string }
  | { readonly type: "title"; readonly position: "prepend" | "append"; readonly text: string }
  | { readonly type: "reply"; readonly bodyMd: string; readonly authorId: string | null };

interface ActionRecord {
  readonly id: string;
  readonly name: string;
  readonly forumIds: readonly string[];
  readonly steps: readonly Step[];
}

const STEP_TYPES = ["move", "lock", "pin", "prefix", "title", "reply"] as const;
type StepType = (typeof STEP_TYPES)[number];

function emptyStep(type: StepType): Step {
  switch (type) {
    case "move":
      return { type: "move", forumId: "" };
    case "lock":
      return { type: "lock", locked: true };
    case "pin":
      return { type: "pin", pinned: true };
    case "prefix":
      return { type: "prefix", prefixId: "" };
    case "title":
      return { type: "title", position: "prepend", text: "" };
    case "reply":
      return { type: "reply", bodyMd: "", authorId: null };
  }
}

function stepTypeLabel(t: ReturnType<typeof useT>, type: StepType): string {
  switch (type) {
    case "move":
      return t("staff.multimod.step.move");
    case "lock":
      return t("staff.multimod.step.lock");
    case "pin":
      return t("staff.multimod.step.pin");
    case "prefix":
      return t("staff.multimod.step.prefix");
    case "title":
      return t("staff.multimod.step.title");
    case "reply":
      return t("staff.multimod.step.reply");
  }
}

export function MultimodPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [forumIds, setForumIds] = useState<readonly string[]>([]);
  const [steps, setSteps] = useState<readonly Step[]>([]);
  const [stepType, setStepType] = useState<StepType>("prefix");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const actions = useQuery({
    queryKey: ["staff", "multimod"],
    queryFn: () => apiGet<{ actions: ActionRecord[] }>("/api/staff/multimod"),
  });
  const forums = useQuery({
    queryKey: ["staff", "forums"],
    queryFn: () => apiGet<{ forums: ForumRecord[] }>("/api/staff/forums"),
  });
  const prefixes = useQuery({
    queryKey: ["staff", "prefixes"],
    queryFn: () => apiGet<{ prefixes: PrefixRecord[] }>("/api/staff/prefixes"),
  });
  const serviceMembers = useQuery({
    queryKey: ["staff", "multimod", "service-members"],
    queryFn: () => apiGet<{ members: ServiceMember[] }>("/api/staff/multimod/service-members"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/multimod", body),
    onSuccess: async () => {
      toast.pushToast({ messageKey: "staff.multimod.saved", tone: "success" });
      reset();
      await queryClient.invalidateQueries({ queryKey: ["staff", "multimod"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiPost("/api/staff/multimod", { action: "delete", id }),
    onSuccess: async () => {
      toast.pushToast({ messageKey: "staff.multimod.deleted", tone: "success" });
      reset();
      await queryClient.invalidateQueries({ queryKey: ["staff", "multimod"] });
    },
  });

  const reset = (): void => {
    setEditing(null);
    setName("");
    setForumIds([]);
    setSteps([]);
  };

  const edit = (action: ActionRecord): void => {
    setEditing(action.id);
    setName(action.name);
    setForumIds(action.forumIds);
    setSteps(action.steps);
  };

  const updateStep = (index: number, next: Step): void => {
    setSteps((current) => current.map((step, position) => (position === index ? next : step)));
  };

  const toggleValue = (values: readonly string[], value: string): readonly string[] =>
    values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];

  const forumOptions = (forums.data?.forums ?? []).filter((forum) => forum.type === "forum");

  const renderStep = (step: Step, index: number) => {
    const label = t("staff.multimod.stepValue", { index: index + 1 });

    switch (step.type) {
      case "move":
        return (
          <Select
            aria-label={label}
            data-step-forum
            value={step.forumId}
            onChange={(event) => updateStep(index, { ...step, forumId: event.target.value })}
          >
            <option value="">{t("staff.multimod.chooseForum")}</option>
            {forumOptions.map((forum) => (
              <option key={forum.id} value={forum.id}>
                {forum.title}
              </option>
            ))}
          </Select>
        );
      case "lock":
        return (
          <Select
            aria-label={label}
            data-step-locked
            value={step.locked ? "lock" : "unlock"}
            onChange={(event) =>
              updateStep(index, { ...step, locked: event.target.value === "lock" })
            }
          >
            <option value="lock">{t("staff.multimod.lock")}</option>
            <option value="unlock">{t("staff.multimod.unlock")}</option>
          </Select>
        );
      case "pin":
        return (
          <Select
            aria-label={label}
            data-step-pinned
            value={step.pinned ? "pin" : "unpin"}
            onChange={(event) =>
              updateStep(index, { ...step, pinned: event.target.value === "pin" })
            }
          >
            <option value="pin">{t("staff.multimod.pin")}</option>
            <option value="unpin">{t("staff.multimod.unpin")}</option>
          </Select>
        );
      case "prefix":
        return (
          <Select
            aria-label={label}
            data-step-prefix
            value={step.prefixId}
            onChange={(event) => updateStep(index, { ...step, prefixId: event.target.value })}
          >
            <option value="">{t("staff.multimod.choosePrefix")}</option>
            {(prefixes.data?.prefixes ?? []).map((prefix) => (
              <option key={prefix.id} value={prefix.id}>
                {prefix.labels.en ?? prefix.key}
              </option>
            ))}
          </Select>
        );
      case "title":
        return (
          <div className="form-grid">
            <Select
              aria-label={label}
              data-step-position
              value={step.position}
              onChange={(event) =>
                updateStep(index, {
                  ...step,
                  position: event.target.value === "append" ? "append" : "prepend",
                })
              }
            >
              <option value="prepend">{t("staff.multimod.prepend")}</option>
              <option value="append">{t("staff.multimod.append")}</option>
            </Select>
            <TextInput
              aria-label={t("staff.multimod.titleText")}
              data-step-title
              value={step.text}
              maxLength={100}
              placeholder={t("staff.multimod.titleText")}
              onChange={(event) => updateStep(index, { ...step, text: event.target.value })}
            />
          </div>
        );
      case "reply":
        return (
          <div className="stack stack-sm">
            <Textarea
              aria-label={t("staff.multimod.replyBody")}
              data-step-reply
              rows={3}
              value={step.bodyMd}
              placeholder={t("staff.multimod.replyBody")}
              onChange={(event) => updateStep(index, { ...step, bodyMd: event.target.value })}
            />
            <Select
              aria-label={t("staff.multimod.replyAuthor")}
              data-step-author
              value={step.authorId ?? ""}
              onChange={(event) =>
                updateStep(index, {
                  ...step,
                  authorId: event.target.value === "" ? null : event.target.value,
                })
              }
            >
              <option value="">{t("staff.multimod.actingModerator")}</option>
              {(serviceMembers.data?.members ?? []).map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name ?? t("staff.multimod.serviceMember")}
                </option>
              ))}
            </Select>
          </div>
        );
    }
  };

  return (
    <Page id="multimod" title={t("staff.multimod.title")} description={t("staff.multimod.intro")}>
      <div className="page-split">
        <Panel flush title={t("staff.multimod.existing")}>
          <ul className="list" data-multimod-list>
            {(actions.data?.actions ?? []).map((action) => (
              <li
                key={action.id}
                className={action.id === editing ? "list-row is-selected" : "list-row"}
                data-multimod-row={action.id}
              >
                <div className="list-row-main">
                  <span className="list-row-title">{action.name}</span>
                  <span className="list-row-meta">
                    {t("staff.multimod.stepCount", { count: action.steps.length })}
                  </span>
                </div>
                <div className="list-row-actions">
                  <IconButton
                    size="sm"
                    label={t("staff.multimod.edit")}
                    data-multimod-edit={action.id}
                    onClick={() => edit(action)}
                  >
                    <IconEdit size={16} />
                  </IconButton>
                  <RowActions label={t("staff.rowActions")}>
                    <MenuItem
                      tone="danger"
                      icon={<IconTrash size={16} />}
                      data-multimod-delete={action.id}
                      disabled={remove.isPending}
                      onClick={() => setConfirmId(action.id)}
                    >
                      {t("staff.multimod.delete")}
                    </MenuItem>
                  </RowActions>
                </div>
              </li>
            ))}
          </ul>
          {(actions.data?.actions ?? []).length === 0 ? (
            <EmptyState title={t("staff.multimod.empty")} />
          ) : null}
        </Panel>

        <Panel
          title={editing === null ? t("staff.multimod.create") : t("staff.multimod.edit")}
          data-multimod-editor
        >
          <div className="stack">
            <Field label={t("staff.multimod.name")}>
              {({ id }) => (
                <TextInput
                  id={id}
                  data-multimod-name
                  value={name}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
            <fieldset className="field-group">
              <legend>{t("staff.multimod.forums")}</legend>
              <div className="check-grid">
                {forumOptions.map((forum) => (
                  <Checkbox
                    key={forum.id}
                    label={forum.title}
                    data-multimod-forum={forum.id}
                    checked={forumIds.includes(forum.id)}
                    onChange={() => setForumIds((current) => toggleValue(current, forum.id))}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="field-group">
              <legend>{t("staff.multimod.steps")}</legend>
              <ol className="list step-list" data-multimod-steps>
                {steps.map((step, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are an editable ordered list
                    key={`${step.type}-${index}`}
                    className="step-row"
                    data-multimod-step={step.type}
                  >
                    <span className="step-row-index" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div className="step-row-main">
                      <span className="list-row-title">{stepTypeLabel(t, step.type)}</span>
                      {renderStep(step, index)}
                    </div>
                    <IconButton
                      size="sm"
                      label={t("staff.multimod.removeStep")}
                      data-step-remove={index}
                      onClick={() =>
                        setSteps((current) => current.filter((_, pos) => pos !== index))
                      }
                    >
                      <IconTrash size={16} />
                    </IconButton>
                  </li>
                ))}
              </ol>
              <div className="cluster">
                <Select
                  aria-label={t("staff.multimod.stepType")}
                  className="input-narrow"
                  data-step-type
                  value={stepType}
                  onChange={(event) => setStepType(event.target.value as StepType)}
                >
                  {STEP_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {stepTypeLabel(t, type)}
                    </option>
                  ))}
                </Select>
                <Button
                  icon={<IconPlus size={16} />}
                  data-step-add
                  onClick={() => setSteps((current) => [...current, emptyStep(stepType)])}
                >
                  {t("staff.multimod.addStep")}
                </Button>
              </div>
            </fieldset>

            <FormActions>
              <Button variant="ghost" onClick={reset}>
                {t("staff.multimod.cancel")}
              </Button>
              <Button
                variant="primary"
                data-multimod-save
                disabled={mutate.isPending}
                onClick={() =>
                  mutate.mutate({
                    action: "save",
                    ...(editing === null ? {} : { id: editing }),
                    name,
                    forumIds,
                    steps,
                  })
                }
              >
                {t("staff.multimod.save")}
              </Button>
            </FormActions>
          </div>
        </Panel>
      </div>

      <ConfirmDialog
        open={confirmId !== null}
        titleKey="staff.multimod.confirmDelete.title"
        bodyKey="staff.multimod.confirmDelete.body"
        confirmLabelKey="staff.multimod.delete"
        tone="danger"
        busy={remove.isPending}
        onCancel={() => setConfirmId(null)}
        onConfirm={() => {
          const id = confirmId;
          setConfirmId(null);

          if (id !== null) {
            remove.mutate(id);
          }
        }}
      />
    </Page>
  );
}
