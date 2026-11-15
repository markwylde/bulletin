import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Button,
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
  QueryState,
  RowActions,
  Table,
  TextInput,
} from "../ui/index.ts";

interface RankView {
  readonly id: string;
  readonly minPosts: number;
  readonly titleLabels: Readonly<Record<string, string>>;
  readonly pips: number;
  readonly imageKey: string | null;
}

interface RankDraft {
  readonly id: string | null;
  readonly minPosts: number;
  readonly en: string;
  readonly es: string;
  readonly fr: string;
  readonly pips: number;
  readonly imageKey: string;
}

const EMPTY: RankDraft = {
  id: null,
  minPosts: 0,
  en: "",
  es: "",
  fr: "",
  pips: 0,
  imageKey: "",
};

export function RanksPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RankDraft>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["staff", "ranks"],
    queryFn: () => apiGet<{ ranks: readonly RankView[] }>("/api/staff/ranks"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/ranks", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.ranks.saved", tone: "success" });
      setEditing(false);
      setDraft(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ["staff", "ranks"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.ranks.saveError", tone: "error" }),
  });

  const save = (): void => {
    if (
      draft.en.trim() === "" ||
      draft.es.trim() === "" ||
      draft.fr.trim() === "" ||
      draft.minPosts < 0 ||
      draft.pips < 0
    ) {
      toast.pushToast({ messageKey: "staff.ranks.invalid", tone: "error" });
      return;
    }

    mutate.mutate({
      action: "save",
      rank: {
        ...(draft.id === null ? {} : { id: draft.id }),
        minPosts: draft.minPosts,
        pips: draft.pips,
        imageKey: draft.imageKey.trim(),
        titleLabels: { en: draft.en, es: draft.es, fr: draft.fr },
      },
    });
  };

  const startNew = (): void => {
    setDraft(EMPTY);
    setEditing(true);
  };
  const labelField = (locale: "en" | "es" | "fr", label: string) => (
    <Field label={label}>
      {({ id }) => (
        <TextInput
          id={id}
          {...{ [`data-rank-label-${locale}`]: true }}
          value={draft[locale]}
          onChange={(event) =>
            setDraft((current) => ({ ...current, [locale]: event.target.value }))
          }
        />
      )}
    </Field>
  );

  return (
    <Page
      id="ranks"
      title={t("staff.ranks.title")}
      description={t("staff.ranks.intro")}
      actions={
        <Button
          variant="primary"
          icon={<IconPlus size={16} />}
          data-rank-new
          disabled={!query.isSuccess}
          onClick={startNew}
        >
          {t("staff.ranks.add")}
        </Button>
      }
    >
      <QueryState query={query} errorLabel={t("staff.ranks.loadError")}>
        {(data) => (
          <div className={editing ? "page-split" : undefined}>
            <Panel flush title={t("staff.ranks.title")} data-rank-list>
              <Table
                caption={t("staff.ranks.title")}
                rows={data.ranks}
                rowKey={(rank) => rank.id}
                rowProps={(rank) => ({
                  "data-rank": rank.id,
                  className: editing && rank.id === draft.id ? "is-selected" : undefined,
                })}
                empty={
                  <EmptyState
                    title={t("staff.ranks.empty")}
                    action={
                      <Button size="sm" onClick={startNew}>
                        {t("staff.ranks.add")}
                      </Button>
                    }
                  />
                }
                columns={[
                  {
                    id: "title",
                    header: t("staff.ranks.labelEn"),
                    primary: true,
                    cell: (rank) => (
                      <span className="list-row-title">{rank.titleLabels.en ?? ""}</span>
                    ),
                  },
                  {
                    id: "minPosts",
                    header: t("staff.ranks.minPosts"),
                    align: "end",
                    cell: (rank) => rank.minPosts,
                  },
                  {
                    id: "pips",
                    header: t("staff.ranks.pips"),
                    align: "end",
                    cell: (rank) => (
                      <span className="pips">
                        <span aria-hidden="true">
                          {rank.pips === 0 ? "—" : "●".repeat(Math.min(rank.pips, 10))}
                        </span>
                        <span className="sr-only">
                          {t("staff.ranks.pipsValue", { count: rank.pips })}
                        </span>
                      </span>
                    ),
                  },
                  {
                    id: "actions",
                    header: t("staff.rowActions"),
                    align: "end",
                    width: "5.5rem",
                    cell: (rank) => (
                      <span className="cluster cluster-end">
                        <IconButton
                          size="sm"
                          label={t("staff.ranks.edit")}
                          data-rank-edit={rank.id}
                          onClick={() => {
                            setDraft({
                              id: rank.id,
                              minPosts: rank.minPosts,
                              en: rank.titleLabels.en ?? "",
                              es: rank.titleLabels.es ?? "",
                              fr: rank.titleLabels.fr ?? "",
                              pips: rank.pips,
                              imageKey: rank.imageKey ?? "",
                            });
                            setEditing(true);
                          }}
                        >
                          <IconEdit size={16} />
                        </IconButton>
                        <RowActions label={t("staff.rowActions")}>
                          <MenuItem
                            tone="danger"
                            icon={<IconTrash size={16} />}
                            data-rank-delete={rank.id}
                            onClick={() => setDeleteId(rank.id)}
                          >
                            {t("staff.ranks.delete")}
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
                title={draft.id === null ? t("staff.ranks.create") : t("staff.ranks.editTitle")}
                data-rank-editor
              >
                <div className="stack">
                  <div className="form-grid">
                    <Field label={t("staff.ranks.minPosts")}>
                      {({ id }) => (
                        <TextInput
                          id={id}
                          type="number"
                          min={0}
                          data-rank-min-posts
                          value={draft.minPosts}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              minPosts: Number(event.target.value),
                            }))
                          }
                        />
                      )}
                    </Field>
                    <Field label={t("staff.ranks.pips")}>
                      {({ id }) => (
                        <TextInput
                          id={id}
                          type="number"
                          min={0}
                          max={20}
                          data-rank-pips
                          value={draft.pips}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              pips: Number(event.target.value),
                            }))
                          }
                        />
                      )}
                    </Field>
                  </div>
                  <Field label={t("staff.ranks.imageKey")}>
                    {({ id }) => (
                      <TextInput
                        id={id}
                        data-rank-image
                        value={draft.imageKey}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, imageKey: event.target.value }))
                        }
                      />
                    )}
                  </Field>
                  {labelField("en", t("staff.ranks.labelEn"))}
                  {labelField("es", t("staff.ranks.labelEs"))}
                  {labelField("fr", t("staff.ranks.labelFr"))}
                  <FormActions>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(false);
                        setDraft(EMPTY);
                      }}
                    >
                      {t("staff.ranks.cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      data-rank-save
                      disabled={mutate.isPending}
                      onClick={save}
                    >
                      {t("staff.ranks.save")}
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
        titleKey="staff.ranks.confirmDelete.title"
        bodyKey="staff.ranks.confirmDelete.body"
        confirmLabelKey="staff.ranks.delete"
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
