import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  IconEdit,
  IconPlus,
  IconTrash,
  Page,
  Panel,
  QueryState,
  Table,
  TextInput,
} from "../ui/index.ts";

interface PrefixRecord {
  readonly id: string;
  readonly key: string;
  readonly colour: string;
  readonly labels: Readonly<Record<string, string | undefined>>;
  readonly groupIds: readonly string[];
}

interface PrefixView {
  readonly prefixes: readonly PrefixRecord[];
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
}

interface Draft {
  readonly id: string | null;
  readonly key: string;
  readonly colour: string;
  readonly en: string;
  readonly es: string;
  readonly fr: string;
  readonly groupIds: readonly string[];
}

const EMPTY: Draft = {
  id: null,
  key: "",
  colour: "#6b7280",
  en: "",
  es: "",
  fr: "",
  groupIds: [],
};

function draftFrom(prefix: PrefixRecord): Draft {
  return {
    id: prefix.id,
    key: prefix.key,
    colour: prefix.colour,
    en: prefix.labels.en ?? "",
    es: prefix.labels.es ?? "",
    fr: prefix.labels.fr ?? "",
    groupIds: prefix.groupIds,
  };
}

export function PrefixesPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const query = useQuery({
    queryKey: ["staff", "prefixes"],
    queryFn: () => apiGet<PrefixView>("/api/staff/prefixes"),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/prefixes", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.prefixes.saved", tone: "success" });
      setDraft(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ["staff", "prefixes"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.prefixes.saveError", tone: "error" }),
  });

  useEffect(() => {
    if (query.isSuccess && draft.id !== null) {
      const current = query.data.prefixes.find((prefix) => prefix.id === draft.id);

      if (current !== undefined) {
        setDraft(draftFrom(current));
      }
    }
  }, [query.data, query.isSuccess, draft.id]);

  const toggleGroup = (groupId: string, checked: boolean): void => {
    setDraft((current) => ({
      ...current,
      groupIds: checked
        ? [...current.groupIds, groupId]
        : current.groupIds.filter((id) => id !== groupId),
    }));
  };

  const textField = (field: "key" | "en" | "es" | "fr", label: string, hook: string) => (
    <Field label={label}>
      {({ id }) => (
        <TextInput
          id={id}
          data-prefix-field={hook}
          value={draft[field]}
          onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
        />
      )}
    </Field>
  );

  return (
    <Page
      id="prefixes"
      title={t("staff.prefixes.title")}
      description={t("staff.prefixes.intro")}
      actions={
        draft.id === null ? undefined : (
          <Button
            variant="primary"
            icon={<IconPlus size={16} />}
            data-prefix-new
            onClick={() => setDraft(EMPTY)}
          >
            {t("staff.prefixes.create.title")}
          </Button>
        )
      }
    >
      <QueryState query={query} errorLabel={t("staff.prefixes.loadError")}>
        {(data) => (
          <div className="page-split">
            <Panel flush title={t("staff.prefixes.list.title")} data-prefix-list>
              <Table
                caption={t("staff.prefixes.list.title")}
                rows={data.prefixes}
                rowKey={(prefix) => prefix.id}
                rowProps={(prefix) => ({
                  "data-prefix-row": prefix.key,
                  className: prefix.id === draft.id ? "is-selected" : undefined,
                })}
                empty={<EmptyState title={t("staff.prefixes.empty")} />}
                columns={[
                  {
                    id: "label",
                    header: t("staff.prefixes.label.en"),
                    primary: true,
                    cell: (prefix) => (
                      <span
                        className="prefix-chip"
                        style={{ "--chip": prefix.colour } as CSSProperties}
                      >
                        {prefix.labels.en ?? prefix.key}
                      </span>
                    ),
                  },
                  {
                    id: "key",
                    header: t("staff.prefixes.key"),
                    cell: (prefix) => <code>{prefix.key}</code>,
                  },
                  {
                    id: "groups",
                    header: t("staff.prefixes.groups.title"),
                    cell: (prefix) =>
                      prefix.groupIds.length === 0 ? (
                        <span className="muted">{t("staff.prefixes.groups.all")}</span>
                      ) : (
                        prefix.groupIds
                          .map(
                            (groupId) =>
                              data.groups.find((group) => group.id === groupId)?.title ?? groupId,
                          )
                          .join(", ")
                      ),
                  },
                  {
                    id: "actions",
                    header: t("staff.rowActions"),
                    align: "end",
                    width: "3rem",
                    cell: (prefix) => (
                      <IconButton
                        size="sm"
                        label={t("staff.prefixes.edit")}
                        data-prefix-edit={prefix.key}
                        onClick={() => setDraft(draftFrom(prefix))}
                      >
                        <IconEdit size={16} />
                      </IconButton>
                    ),
                  },
                ]}
              />
            </Panel>

            <Panel
              title={
                draft.id === null
                  ? t("staff.prefixes.create.title")
                  : t("staff.prefixes.edit.title")
              }
            >
              <div className="stack" data-prefix-editor>
                <div className="form-grid">
                  {textField("key", t("staff.prefixes.key"), "key")}
                  <Field label={t("staff.prefixes.colour")}>
                    {({ id }) => (
                      <div className="with-swatch">
                        <input
                          id={id}
                          type="color"
                          data-prefix-field="colour"
                          value={draft.colour}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, colour: event.target.value }))
                          }
                        />
                        <code>{draft.colour}</code>
                      </div>
                    )}
                  </Field>
                </div>
                {textField("en", t("staff.prefixes.label.en"), "label-en")}
                {textField("es", t("staff.prefixes.label.es"), "label-es")}
                {textField("fr", t("staff.prefixes.label.fr"), "label-fr")}
                <fieldset className="field field-group">
                  <legend className="field-label">{t("staff.prefixes.groups.title")}</legend>
                  <div className="check-grid">
                    {data.groups.map((group) => (
                      <Checkbox
                        key={group.id}
                        label={group.title}
                        data-prefix-group={group.id}
                        checked={draft.groupIds.includes(group.id)}
                        onChange={(event) => toggleGroup(group.id, event.target.checked)}
                      />
                    ))}
                  </div>
                </fieldset>
                <div className="form-actions-bar form-actions-split">
                  {draft.id === null ? (
                    <span />
                  ) : (
                    <Button
                      variant="danger"
                      icon={<IconTrash size={16} />}
                      data-prefix-delete
                      disabled={save.isPending}
                      onClick={() => setConfirmDelete(true)}
                    >
                      {t("staff.prefixes.delete")}
                    </Button>
                  )}
                  <span className="cluster">
                    <Button variant="ghost" data-prefix-cancel onClick={() => setDraft(EMPTY)}>
                      {t("staff.prefixes.cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      data-prefix-save
                      disabled={save.isPending}
                      onClick={() =>
                        save.mutate({
                          action: "save",
                          ...(draft.id === null ? {} : { id: draft.id }),
                          key: draft.key,
                          colour: draft.colour,
                          labels: { en: draft.en, es: draft.es, fr: draft.fr },
                          groupIds: draft.groupIds,
                        })
                      }
                    >
                      {t("staff.prefixes.save")}
                    </Button>
                  </span>
                </div>
              </div>
            </Panel>
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={confirmDelete}
        titleKey="staff.prefixes.confirmDelete.title"
        bodyKey="staff.prefixes.confirmDelete.body"
        confirmLabelKey="staff.prefixes.delete"
        tone="danger"
        busy={save.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          save.mutate({ action: "delete", id: draft.id });
        }}
      />
    </Page>
  );
}
