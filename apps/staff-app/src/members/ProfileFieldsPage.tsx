import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormActions,
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
  Table,
  TextInput,
} from "../ui/index.ts";

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
  const [deleteId, setDeleteId] = useState<string | null>(null);
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
  const fields = query.data?.fields ?? [];
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

  type LabelKey = "en" | "es" | "fr";
  const setOption = (index: number, patch: Partial<(typeof draft.options)[number]>): void =>
    setDraft((current) => ({
      ...current,
      options: current.options.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    }));
  const labelField = (locale: LabelKey, labelKey: string) => (
    <Field label={t(labelKey)}>
      {({ id }) => (
        <TextInput
          id={id}
          {...{ [`data-profile-field-label-${locale}`]: true }}
          value={draft[locale]}
          onChange={(event) =>
            setDraft((current) => ({ ...current, [locale]: event.target.value }))
          }
        />
      )}
    </Field>
  );
  const visibility = (field: (typeof fields)[number]): string =>
    field.groups.length === 0
      ? t("staff.profileFields.everyone")
      : field.groups
          .filter((group) => group.canView)
          .map((group) => group.groupTitle)
          .join(", ");

  return (
    <Page
      id="profile-fields"
      title={t("staff.profileFields.title")}
      description={t("staff.profileFields.intro")}
      actions={
        <Button
          variant="primary"
          icon={<IconPlus size={16} />}
          data-profile-field-new
          disabled={!query.isSuccess}
          onClick={startCreate}
        >
          {t("staff.profileFields.add")}
        </Button>
      }
    >
      <QueryState query={query} errorLabel={t("staff.profileFields.loadError")}>
        {() => (
          <div className={editing ? "page-split" : undefined}>
            <Panel flush title={t("staff.profileFields.list")} data-profile-field-list>
              <Table
                caption={t("staff.profileFields.list")}
                rows={fields}
                rowKey={(field) => field.id}
                rowProps={(field) => ({
                  "data-profile-field": field.id,
                  className: editing && field.id === draft.id ? "is-selected" : undefined,
                })}
                empty={
                  <div data-profile-fields-empty>
                    <EmptyState
                      title={t("staff.profileFields.empty")}
                      action={
                        <Button size="sm" onClick={startCreate}>
                          {t("staff.profileFields.add")}
                        </Button>
                      }
                    />
                  </div>
                }
                columns={[
                  {
                    id: "label",
                    header: t("staff.profileFields.labelEn"),
                    primary: true,
                    cell: (field) => (
                      <div className="stack stack-sm">
                        <span className="list-row-title">
                          {field.labels.en ?? ""}{" "}
                          {field.required ? (
                            <Badge tone="accent">{t("staff.profileFields.required")}</Badge>
                          ) : null}
                        </span>
                        <span className="subtle">
                          {t("staff.profileFields.visibility", { groups: visibility(field) })}
                        </span>
                      </div>
                    ),
                  },
                  {
                    id: "type",
                    header: t("staff.profileFields.type"),
                    cell: (field) => <TypeLabel type={field.type} />,
                  },
                  {
                    id: "position",
                    header: t("staff.profileFields.positionLabel"),
                    align: "end",
                    cell: (field) => field.position,
                  },
                  {
                    id: "actions",
                    header: t("staff.rowActions"),
                    align: "end",
                    width: "5.5rem",
                    cell: (field) => (
                      <span className="cluster cluster-end">
                        <IconButton
                          size="sm"
                          label={t("staff.profileFields.edit")}
                          data-profile-field-edit={field.id}
                          onClick={() => startEdit(field)}
                        >
                          <IconEdit size={16} />
                        </IconButton>
                        <RowActions label={t("staff.rowActions")}>
                          <MenuItem
                            tone="danger"
                            icon={<IconTrash size={16} />}
                            data-profile-field-delete={field.id}
                            onClick={() => setDeleteId(field.id)}
                          >
                            {t("staff.profileFields.delete")}
                          </MenuItem>
                        </RowActions>
                      </span>
                    ),
                  },
                ]}
              />
            </Panel>

            {editing ? (
              <Panel
                data-profile-field-editor
                title={
                  draft.id === null
                    ? t("staff.profileFields.create")
                    : t("staff.profileFields.editTitle")
                }
              >
                <div className="stack">
                  <div className="form-grid">
                    <Field label={t("staff.profileFields.type")}>
                      {({ id }) => (
                        <Select
                          id={id}
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
                        </Select>
                      )}
                    </Field>
                    <Field label={t("staff.profileFields.positionLabel")}>
                      {({ id }) => (
                        <TextInput
                          id={id}
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
                      )}
                    </Field>
                  </div>
                  <Checkbox
                    data-profile-field-required
                    label={t("staff.profileFields.requiredLabel")}
                    checked={draft.required}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, required: event.target.checked }))
                    }
                  />
                  {labelField("en", "staff.profileFields.labelEn")}
                  {labelField("es", "staff.profileFields.labelEs")}
                  {labelField("fr", "staff.profileFields.labelFr")}

                  {usesOptions ? (
                    <fieldset className="field field-group">
                      <legend className="field-label">{t("staff.profileFields.options")}</legend>
                      <div className="stack stack-sm">
                        {draft.options.map((option, index) => (
                          <div className="option-row" key={option.id}>
                            <TextInput
                              aria-label={t("staff.profileFields.optionValue")}
                              placeholder={t("staff.profileFields.optionValue")}
                              value={option.value}
                              onChange={(event) => setOption(index, { value: event.target.value })}
                            />
                            {(["en", "es", "fr"] as const).map((locale) => (
                              <TextInput
                                key={locale}
                                aria-label={t(
                                  locale === "en"
                                    ? "staff.profileFields.labelEn"
                                    : locale === "es"
                                      ? "staff.profileFields.labelEs"
                                      : "staff.profileFields.labelFr",
                                )}
                                placeholder={locale.toUpperCase()}
                                value={option[locale]}
                                onChange={(event) =>
                                  setOption(index, { [locale]: event.target.value })
                                }
                              />
                            ))}
                            <IconButton
                              size="sm"
                              label={t("staff.profileFields.removeOption")}
                              onClick={() =>
                                setDraft((current) => ({
                                  ...current,
                                  options: current.options.filter(
                                    (_entry, entryIndex) => entryIndex !== index,
                                  ),
                                }))
                              }
                            >
                              <IconClose size={16} />
                            </IconButton>
                          </div>
                        ))}
                        <div>
                          <Button
                            size="sm"
                            icon={<IconPlus size={14} />}
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
                          </Button>
                        </div>
                      </div>
                    </fieldset>
                  ) : null}

                  <fieldset className="field field-group">
                    <legend className="field-label">{t("staff.profileFields.groups")}</legend>
                    <p className="field-description">{t("staff.profileFields.groupsHelp")}</p>
                    <div className="mini-table">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">{t("staff.profileFields.group")}</th>
                            <th scope="col" className="align-end">
                              {t("staff.profileFields.canView")}
                            </th>
                            <th scope="col" className="align-end">
                              {t("staff.profileFields.canEdit")}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {groups.map((group) => {
                            const rule = draft.groups.find((entry) => entry.groupId === group.id);

                            return (
                              <tr key={group.id} data-profile-field-group={group.id}>
                                <th scope="row">{group.title}</th>
                                <td className="align-end">
                                  <input
                                    type="checkbox"
                                    aria-label={`${group.title}: ${t("staff.profileFields.canView")}`}
                                    checked={rule?.canView === true}
                                    onChange={(event) =>
                                      setDraft((current) => ({
                                        ...current,
                                        groups: current.groups.map((entry) =>
                                          entry.groupId === group.id
                                            ? {
                                                ...entry,
                                                canView: event.target.checked,
                                                canEdit: event.target.checked
                                                  ? entry.canEdit
                                                  : false,
                                              }
                                            : entry,
                                        ),
                                      }))
                                    }
                                  />
                                </td>
                                <td className="align-end">
                                  <input
                                    type="checkbox"
                                    aria-label={`${group.title}: ${t("staff.profileFields.canEdit")}`}
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
                  </fieldset>

                  <FormActions>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(false);
                        setDraft(emptyDraft());
                      }}
                    >
                      {t("staff.profileFields.cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      data-profile-field-save
                      disabled={mutate.isPending}
                      onClick={save}
                    >
                      {t("staff.profileFields.save")}
                    </Button>
                  </FormActions>
                </div>
              </Panel>
            ) : null}
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={deleteId !== null}
        titleKey="staff.profileFields.confirmDelete.title"
        bodyKey="staff.profileFields.confirmDelete.body"
        confirmLabelKey="staff.profileFields.delete"
        tone="danger"
        busy={mutate.isPending}
        onCancel={() => setDeleteId(null)}
        onConfirm={() => {
          const id = deleteId;
          setDeleteId(null);

          if (id !== null) {
            mutate.mutate({ action: "delete", id });
          }
        }}
      />
    </Page>
  );
}
