import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

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

  return (
    <div className="page" data-page="multimod">
      <header className="page-header">
        <h1>{t("staff.multimod.title")}</h1>
        <p>{t("staff.multimod.intro")}</p>
      </header>

      <section className="admin-panel" data-multimod-editor>
        <h2>{editing === null ? t("staff.multimod.create") : t("staff.multimod.edit")}</h2>
        <div className="admin-form">
          <label>
            <span>{t("staff.multimod.name")}</span>
            <input
              data-multimod-name
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <fieldset>
            <legend>{t("staff.multimod.forums")}</legend>
            <ul className="check-list">
              {forumOptions.map((forum) => (
                <li key={forum.id}>
                  <label>
                    <input
                      type="checkbox"
                      data-multimod-forum={forum.id}
                      checked={forumIds.includes(forum.id)}
                      onChange={() => setForumIds((current) => toggleValue(current, forum.id))}
                    />
                    <span>{forum.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <fieldset>
            <legend>{t("staff.multimod.steps")}</legend>
            <ol className="multimod-steps" data-multimod-steps>
              {steps.map((step, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are an editable ordered list
                <li key={`${step.type}-${index}`} data-multimod-step={step.type}>
                  <strong>{stepTypeLabel(t, step.type)}</strong>
                  {step.type === "move" ? (
                    <select
                      data-step-forum
                      value={step.forumId}
                      onChange={(event) =>
                        updateStep(index, { ...step, forumId: event.target.value })
                      }
                    >
                      <option value="">{t("staff.multimod.chooseForum")}</option>
                      {forumOptions.map((forum) => (
                        <option key={forum.id} value={forum.id}>
                          {forum.title}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {step.type === "lock" ? (
                    <select
                      data-step-locked
                      value={step.locked ? "lock" : "unlock"}
                      onChange={(event) =>
                        updateStep(index, { ...step, locked: event.target.value === "lock" })
                      }
                    >
                      <option value="lock">{t("staff.multimod.lock")}</option>
                      <option value="unlock">{t("staff.multimod.unlock")}</option>
                    </select>
                  ) : null}
                  {step.type === "pin" ? (
                    <select
                      data-step-pinned
                      value={step.pinned ? "pin" : "unpin"}
                      onChange={(event) =>
                        updateStep(index, { ...step, pinned: event.target.value === "pin" })
                      }
                    >
                      <option value="pin">{t("staff.multimod.pin")}</option>
                      <option value="unpin">{t("staff.multimod.unpin")}</option>
                    </select>
                  ) : null}
                  {step.type === "prefix" ? (
                    <select
                      data-step-prefix
                      value={step.prefixId}
                      onChange={(event) =>
                        updateStep(index, { ...step, prefixId: event.target.value })
                      }
                    >
                      <option value="">{t("staff.multimod.choosePrefix")}</option>
                      {(prefixes.data?.prefixes ?? []).map((prefix) => (
                        <option key={prefix.id} value={prefix.id}>
                          {prefix.labels.en ?? prefix.key}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {step.type === "title" ? (
                    <>
                      <select
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
                      </select>
                      <input
                        data-step-title
                        value={step.text}
                        maxLength={100}
                        placeholder={t("staff.multimod.titleText")}
                        onChange={(event) =>
                          updateStep(index, { ...step, text: event.target.value })
                        }
                      />
                    </>
                  ) : null}
                  {step.type === "reply" ? (
                    <>
                      <textarea
                        data-step-reply
                        rows={3}
                        value={step.bodyMd}
                        placeholder={t("staff.multimod.replyBody")}
                        onChange={(event) =>
                          updateStep(index, { ...step, bodyMd: event.target.value })
                        }
                      />
                      <select
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
                      </select>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="button-quiet"
                    data-step-remove={index}
                    onClick={() => setSteps((current) => current.filter((_, pos) => pos !== index))}
                  >
                    {t("staff.multimod.removeStep")}
                  </button>
                </li>
              ))}
            </ol>
            <div className="admin-form__actions">
              <select
                data-step-type
                value={stepType}
                onChange={(event) => setStepType(event.target.value as StepType)}
              >
                {STEP_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {stepTypeLabel(t, type)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-step-add
                onClick={() => setSteps((current) => [...current, emptyStep(stepType)])}
              >
                {t("staff.multimod.addStep")}
              </button>
            </div>
          </fieldset>

          <div className="admin-form__actions">
            <button
              type="button"
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
            </button>
            <button type="button" className="button-quiet" onClick={reset}>
              {t("staff.multimod.cancel")}
            </button>
          </div>
        </div>
      </section>

      <section className="admin-panel">
        <h2>{t("staff.multimod.existing")}</h2>
        <ul className="admin-list" data-multimod-list>
          {(actions.data?.actions ?? []).map((action) => (
            <li key={action.id} data-multimod-row={action.id}>
              <strong>{action.name}</strong>
              <span className="widget-muted">
                {t("staff.multimod.stepCount", { count: action.steps.length })}
              </span>
              <button type="button" className="button-quiet" onClick={() => edit(action)}>
                {t("staff.multimod.edit")}
              </button>
              <button
                type="button"
                className="button-danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(action.id)}
              >
                {t("staff.multimod.delete")}
              </button>
            </li>
          ))}
        </ul>
        {(actions.data?.actions ?? []).length === 0 ? (
          <p className="widget-muted">{t("staff.multimod.empty")}</p>
        ) : null}
      </section>
    </div>
  );
}
