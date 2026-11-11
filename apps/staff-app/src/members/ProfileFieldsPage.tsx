import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiGet, apiPost } from "../api.ts";

interface OptionView {
  readonly value: string;
  readonly labels: Readonly<Record<string, string>>;
}

interface FieldGroupView {
  readonly groupId: string;
  readonly groupTitle: string;
  readonly canView: boolean;
  readonly canEdit: boolean;
}

interface FieldView {
  readonly id: string;
  readonly type: string;
  readonly required: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly options: readonly OptionView[];
  readonly position: number;
  readonly groups: readonly FieldGroupView[];
}

interface FieldsView {
  readonly fields: readonly FieldView[];
  readonly groups: readonly { readonly id: string; readonly title: string }[];
}

interface OptionDraft {
  readonly id: string;
  readonly value: string;
  readonly en: string;
  readonly es: string;
  readonly fr: string;
}

interface GroupDraft {
  readonly groupId: string;
  readonly canView: boolean;
  readonly canEdit: boolean;
}

interface FieldDraft {
  readonly id: string | null;
  readonly type: string;
  readonly required: boolean;
  readonly position: number;
  readonly en: string;
  readonly es: string;
  readonly fr: string;
  readonly options: readonly OptionDraft[];
  readonly groups: readonly GroupDraft[];
}

const TYPES = [
  "short_text",
  "long_text",
  "number",
  "date",
  "url",
  "select",
  "multiselect",
] as const;

function emptyDraft(): FieldDraft {
  return {
    id: null,
    type: "short_text",
    required: false,
    position: 0,
    en: "",
    es: "",
    fr: "",
    options: [],
    groups: [],
  };
}

function draftFrom(field: FieldView, groups: FieldsView["groups"]): FieldDraft {
  return {
    id: field.id,
    type: field.type,
    required: field.required,
    position: field.position,
    en: field.labels.en ?? "",
    es: field.labels.es ?? "",
    fr: field.labels.fr ?? "",
    options: field.options.map((option) => ({
      id: crypto.randomUUID(),
      value: option.value,
      en: option.labels.en ?? "",
      es: option.labels.es ?? "",
      fr: option.labels.fr ?? "",
    })),
    groups: groups.map((group) => {
      const rule = field.groups.find((entry) => entry.groupId === group.id);
      return {
        groupId: group.id,
        canView: rule?.canView ?? false,
        canEdit: rule?.canEdit ?? false,
      };
    }),
  };
}

function TypeLabel({ type }: { readonly type: string }) {
  const t = useT();

  switch (type) {
    case "long_text":
      return <>{t("staff.profileFields.type.longText")}</>;
    case "number":
      return <>{t("staff.profileFields.type.number")}</>;
    case "date":
      return <>{t("staff.profileFields.type.date")}</>;
    case "url":
      return <>{t("staff.profileFields.type.url")}</>;
    case "select":
      return <>{t("staff.profileFields.type.select")}</>;
    case "multiselect":
      return <>{t("staff.profileFields.type.multiselect")}</>;
    default:
      return <>{t("staff.profileFields.type.shortText")}</>;
  }
}

export function ProfileFieldsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<FieldDraft>(emptyDraft);
  const [editing, setEditing] = useState(false);
  const query = useQuery({
    queryKey: ["staff", "profile-fields"],
    queryFn: () => apiGet<FieldsView>("/api/staff/profile-fields"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/profile-fields", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.profileFields.saved", tone: "success" });
      setEditing(false);
      setDraft(emptyDraft());
      void queryClient.invalidateQueries({ queryKey: ["staff", "profile-fields"] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "incompatible_values") {
        toast.pushToast({ messageKey: "staff.profileFields.incompatible", tone: "error" });
        return;
      }

      toast.pushToast({ messageKey: "staff.profileFields.saveError", tone: "error" });
    },
  });

  const groups = query.data?.groups ?? [];
  const usesOptions = draft.type === "select" || draft.type === "multiselect";

  const startCreate = (): void => {
    setDraft({
      ...emptyDraft(),
      groups: groups.map((group) => ({ groupId: group.id, canView: true, canEdit: false })),
    });
    setEditing(true);
  };

  const startEdit = (field: FieldView): void => {
    setDraft(draftFrom(field, groups));
    setEditing(true);
  };

  const save = (): void => {
    if (
      draft.en.trim() === "" ||
      draft.es.trim() === "" ||
      draft.fr.trim() === "" ||
      (usesOptions &&
        (draft.options.length === 0 ||
          draft.options.some(
            (option) =>
              option.value.trim() === "" ||
              option.en.trim() === "" ||
              option.es.trim() === "" ||
              option.fr.trim() === "",
          )))
    ) {
      toast.pushToast({ messageKey: "staff.profileFields.invalid", tone: "error" });
      return;
    }

    mutate.mutate({
      action: "save",
      field: {
        ...(draft.id === null ? {} : { id: draft.id }),
        type: draft.type,
        required: draft.required,
        position: draft.position,
        labels: { en: draft.en, es: draft.es, fr: draft.fr },
        options: usesOptions
          ? draft.options.map((option) => ({
              value: option.value,
              labels: { en: option.en, es: option.es, fr: option.fr },
            }))
          : [],
        groups: draft.groups.filter((group) => group.canView || group.canEdit),
      },
    });
  };

  return (
    <div className="page" data-page="profile-fields">
      <header className="page-header">
        <h1>{t("staff.profileFields.title")}</h1>
        <p>{t("staff.profileFields.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.profileFields.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <>
          <section className="admin-panel" aria-labelledby="profile-field-list-title">
            <h2 id="profile-field-list-title">{t("staff.profileFields.list")}</h2>
            <div className="admin-form">
              <button type="button" data-profile-field-new onClick={startCreate}>
                {t("staff.profileFields.add")}
              </button>
            </div>
            {query.data.fields.length === 0 ? (
              <p className="widget-muted" data-profile-fields-empty>
                {t("staff.profileFields.empty")}
              </p>
            ) : (
              <ul className="profile-field-list" data-profile-field-list>
                {query.data.fields.map((field) => (
                  <li className="profile-field-row" key={field.id} data-profile-field={field.id}>
                    <div className="profile-field-row__main">
                      <strong>{field.labels.en ?? ""}</strong>{" "}
                      <span className="widget-muted">
                        <TypeLabel type={field.type} />
                        {field.required ? ` · ${t("staff.profileFields.required")}` : ""}
                        {` · ${t("staff.profileFields.position", { position: field.position })}`}
                      </span>
                      <div className="widget-muted">
                        {t("staff.profileFields.visibility", {
                          groups:
                            field.groups.length === 0
                              ? t("staff.profileFields.everyone")
                              : field.groups
                                  .filter((group) => group.canView)
                                  .map((group) => group.groupTitle)
                                  .join(", "),
                        })}
                      </div>
                    </div>
                    <div className="admin-form">
                      <button
                        type="button"
                        data-profile-field-edit={field.id}
                        onClick={() => startEdit(field)}
                      >
                        {t("staff.profileFields.edit")}
                      </button>
                      <button
                        type="button"
                        data-profile-field-delete={field.id}
                        onClick={() => mutate.mutate({ action: "delete", id: field.id })}
                      >
                        {t("staff.profileFields.delete")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {editing ? (
            <section className="admin-panel" aria-labelledby="profile-field-editor-title">
              <h2 id="profile-field-editor-title">
                {draft.id === null
                  ? t("staff.profileFields.create")
                  : t("staff.profileFields.editTitle")}
              </h2>
              <div className="admin-form">
                <label>
                  <span>{t("staff.profileFields.type")}</span>
                  <select
                    data-profile-field-type
                    value={draft.type}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, type: event.target.value }))
                    }
                  >
                    {TYPES.map((type) => (
                      <option key={type} value={type}>
                        <TypeLabel type={type} />
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("staff.profileFields.positionLabel")}</span>
                  <input
                    type="number"
                    min={0}
                    data-profile-field-position
                    value={draft.position}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        position: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    data-profile-field-required
                    checked={draft.required}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, required: event.target.checked }))
                    }
                  />
                  <span>{t("staff.profileFields.requiredLabel")}</span>
                </label>
              </div>

              <div className="admin-form">
                <label>
                  <span>{t("staff.profileFields.labelEn")}</span>
                  <input
                    data-profile-field-label-en
                    value={draft.en}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, en: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.profileFields.labelEs")}</span>
                  <input
                    data-profile-field-label-es
                    value={draft.es}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, es: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.profileFields.labelFr")}</span>
                  <input
                    data-profile-field-label-fr
                    value={draft.fr}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, fr: event.target.value }))
                    }
                  />
                </label>
              </div>

              {usesOptions ? (
                <div className="admin-form">
                  <h3>{t("staff.profileFields.options")}</h3>
                  {draft.options.map((option, index) => (
                    <div className="profile-field-option" key={option.id}>
                      <input
                        placeholder={t("staff.profileFields.optionValue")}
                        value={option.value}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            options: current.options.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, value: event.target.value }
                                : entry,
                            ),
                          }))
                        }
                      />
                      <input
                        placeholder={t("staff.profileFields.labelEn")}
                        value={option.en}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            options: current.options.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, en: event.target.value } : entry,
                            ),
                          }))
                        }
                      />
                      <input
                        placeholder={t("staff.profileFields.labelEs")}
                        value={option.es}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            options: current.options.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, es: event.target.value } : entry,
                            ),
                          }))
                        }
                      />
                      <input
                        placeholder={t("staff.profileFields.labelFr")}
                        value={option.fr}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            options: current.options.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, fr: event.target.value } : entry,
                            ),
                          }))
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            options: current.options.filter(
                              (_entry, entryIndex) => entryIndex !== index,
                            ),
                          }))
                        }
                      >
                        {t("staff.profileFields.removeOption")}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    data-profile-field-add-option
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        options: [
                          ...current.options,
                          { id: crypto.randomUUID(), value: "", en: "", es: "", fr: "" },
                        ],
                      }))
                    }
                  >
                    {t("staff.profileFields.addOption")}
                  </button>
                </div>
              ) : null}

              <div className="admin-form">
                <h3>{t("staff.profileFields.groups")}</h3>
                <p className="widget-muted">{t("staff.profileFields.groupsHelp")}</p>
                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("staff.profileFields.group")}</th>
                      <th scope="col">{t("staff.profileFields.canView")}</th>
                      <th scope="col">{t("staff.profileFields.canEdit")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => {
                      const rule = draft.groups.find((entry) => entry.groupId === group.id);

                      return (
                        <tr key={group.id} data-profile-field-group={group.id}>
                          <td>{group.title}</td>
                          <td>
                            <input
                              type="checkbox"
                              checked={rule?.canView === true}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  groups: current.groups.map((entry) =>
                                    entry.groupId === group.id
                                      ? {
                                          ...entry,
                                          canView: event.target.checked,
                                          canEdit: event.target.checked ? entry.canEdit : false,
                                        }
                                      : entry,
                                  ),
                                }))
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={rule?.canEdit === true}
                              disabled={rule?.canView !== true}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  groups: current.groups.map((entry) =>
                                    entry.groupId === group.id
                                      ? { ...entry, canEdit: event.target.checked }
                                      : entry,
                                  ),
                                }))
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="admin-form">
                <button
                  type="button"
                  data-profile-field-save
                  disabled={mutate.isPending}
                  onClick={save}
                >
                  {t("staff.profileFields.save")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(emptyDraft());
                  }}
                >
                  {t("staff.profileFields.cancel")}
                </button>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
