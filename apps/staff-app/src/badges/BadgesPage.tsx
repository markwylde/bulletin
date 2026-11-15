import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
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
  Select,
  Table,
  TextInput,
} from "../ui/index.ts";

interface BadgeRuleView {
  readonly type: string;
  readonly threshold: number;
  readonly forumId: string | null;
}

interface BadgeView {
  readonly id: string;
  readonly key: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly descriptionLabels: Readonly<Record<string, string>>;
  readonly imageKey: string | null;
  readonly position: number;
  readonly rule: BadgeRuleView | null;
}

interface BadgeDraft {
  readonly id: string | null;
  readonly key: string;
  readonly en: string;
  readonly es: string;
  readonly fr: string;
  readonly descEn: string;
  readonly descEs: string;
  readonly descFr: string;
  readonly imageKey: string;
  readonly position: number;
  readonly ruleType: string;
  readonly threshold: number;
  readonly forumId: string;
}

const RULE_TYPES = [
  "post_count",
  "reputation",
  "days_joined",
  "reactions_received",
  "topics_started",
  "posts_in_forum",
] as const;

const EMPTY: BadgeDraft = {
  id: null,
  key: "",
  en: "",
  es: "",
  fr: "",
  descEn: "",
  descEs: "",
  descFr: "",
  imageKey: "",
  position: 0,
  ruleType: "",
  threshold: 0,
  forumId: "",
};

function RuleLabel({ type }: { readonly type: string }) {
  const t = useT();

  switch (type) {
    case "post_count":
      return <>{t("staff.badges.rule.postCount")}</>;
    case "reputation":
      return <>{t("staff.badges.rule.reputation")}</>;
    case "days_joined":
      return <>{t("staff.badges.rule.daysJoined")}</>;
    case "reactions_received":
      return <>{t("staff.badges.rule.reactionsReceived")}</>;
    case "topics_started":
      return <>{t("staff.badges.rule.topicsStarted")}</>;
    case "posts_in_forum":
      return <>{t("staff.badges.rule.postsInForum")}</>;
    default:
      return <>{t("staff.badges.manual")}</>;
  }
}

export function BadgesPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BadgeDraft>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["staff", "badges"],
    queryFn: () => apiGet<{ badges: readonly BadgeView[] }>("/api/staff/badges"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/badges", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.badges.saved", tone: "success" });
      setEditing(false);
      setDraft(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ["staff", "badges"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.badges.saveError", tone: "error" }),
  });

  const save = (): void => {
    const automatic = draft.ruleType !== "";

    if (
      !/^[a-z][a-z0-9_-]{0,31}$/.test(draft.key) ||
      draft.en.trim() === "" ||
      draft.es.trim() === "" ||
      draft.fr.trim() === "" ||
      draft.descEn.trim() === "" ||
      draft.descEs.trim() === "" ||
      draft.descFr.trim() === "" ||
      (automatic &&
        (draft.threshold < 0 || (draft.ruleType === "posts_in_forum" && draft.forumId === "")))
    ) {
      toast.pushToast({ messageKey: "staff.badges.invalid", tone: "error" });
      return;
    }

    mutate.mutate({
      action: "save",
      badge: {
        ...(draft.id === null ? {} : { id: draft.id }),
        key: draft.key,
        labels: { en: draft.en, es: draft.es, fr: draft.fr },
        descriptionLabels: { en: draft.descEn, es: draft.descEs, fr: draft.descFr },
        imageKey: draft.imageKey.trim(),
        position: draft.position,
        rule: automatic
          ? {
              type: draft.ruleType,
              threshold: draft.threshold,
              forumId: draft.ruleType === "posts_in_forum" ? draft.forumId : "",
            }
          : null,
      },
    });
  };

  type TextKey =
    | "key"
    | "en"
    | "es"
    | "fr"
    | "descEn"
    | "descEs"
    | "descFr"
    | "imageKey"
    | "forumId";
  const textField = (field: TextKey, label: string, hook: string) => (
    <Field label={label}>
      {({ id }) => (
        <TextInput
          id={id}
          {...{ [hook]: true }}
          value={draft[field]}
          onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
        />
      )}
    </Field>
  );
  const startNew = (): void => {
    setDraft(EMPTY);
    setEditing(true);
  };

  return (
    <Page
      id="badges"
      title={t("staff.badges.title")}
      description={t("staff.badges.intro")}
      actions={
        <Button
          variant="primary"
          icon={<IconPlus size={16} />}
          data-badge-new
          disabled={!query.isSuccess}
          onClick={startNew}
        >
          {t("staff.badges.add")}
        </Button>
      }
    >
      <QueryState query={query} errorLabel={t("staff.badges.loadError")}>
        {(data) => (
          <div className={editing ? "page-split" : undefined}>
            <Panel flush title={t("staff.badges.title")} data-badge-list>
              <Table
                caption={t("staff.badges.title")}
                rows={data.badges}
                rowKey={(badge) => badge.id}
                rowProps={(badge) => ({
                  "data-badge": badge.id,
                  className: editing && badge.id === draft.id ? "is-selected" : undefined,
                })}
                empty={
                  <EmptyState
                    title={t("staff.badges.empty")}
                    action={
                      <Button size="sm" onClick={startNew}>
                        {t("staff.badges.add")}
                      </Button>
                    }
                  />
                }
                columns={[
                  {
                    id: "label",
                    header: t("staff.badges.labelEn"),
                    primary: true,
                    cell: (badge) => (
                      <div className="stack stack-sm">
                        <span className="list-row-title">{badge.labels.en ?? ""}</span>
                        <span className="subtle">{badge.descriptionLabels.en ?? ""}</span>
                      </div>
                    ),
                  },
                  {
                    id: "key",
                    header: t("staff.badges.key"),
                    cell: (badge) => <code>{badge.key}</code>,
                  },
                  {
                    id: "rule",
                    header: t("staff.badges.rule"),
                    cell: (badge) =>
                      badge.rule === null ? (
                        <Badge>{t("staff.badges.manual")}</Badge>
                      ) : (
                        <span>
                          <RuleLabel type={badge.rule.type} /> ≥ {badge.rule.threshold}
                        </span>
                      ),
                  },
                  {
                    id: "actions",
                    header: t("staff.rowActions"),
                    align: "end",
                    width: "5.5rem",
                    cell: (badge) => (
                      <span className="cluster cluster-end">
                        <IconButton
                          size="sm"
                          label={t("staff.badges.edit")}
                          data-badge-edit={badge.id}
                          onClick={() => {
                            setDraft({
                              id: badge.id,
                              key: badge.key,
                              en: badge.labels.en ?? "",
                              es: badge.labels.es ?? "",
                              fr: badge.labels.fr ?? "",
                              descEn: badge.descriptionLabels.en ?? "",
                              descEs: badge.descriptionLabels.es ?? "",
                              descFr: badge.descriptionLabels.fr ?? "",
                              imageKey: badge.imageKey ?? "",
                              position: badge.position,
                              ruleType: badge.rule?.type ?? "",
                              threshold: badge.rule?.threshold ?? 0,
                              forumId: badge.rule?.forumId ?? "",
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
                            data-badge-delete={badge.id}
                            onClick={() => setDeleteId(badge.id)}
                          >
                            {t("staff.badges.delete")}
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
                data-badge-editor
                title={draft.id === null ? t("staff.badges.create") : t("staff.badges.editTitle")}
              >
                <div className="stack">
                  <div className="form-grid">
                    {textField("key", t("staff.badges.key"), "data-badge-key")}
                    <Field label={t("staff.badges.position")}>
                      {({ id }) => (
                        <TextInput
                          id={id}
                          type="number"
                          min={0}
                          data-badge-position
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
                  {textField("imageKey", t("staff.badges.imageKey"), "data-badge-image")}
                  {textField("en", t("staff.badges.labelEn"), "data-badge-label-en")}
                  {textField("descEn", t("staff.badges.descriptionEn"), "data-badge-desc-en")}
                  {textField("es", t("staff.badges.labelEs"), "data-badge-label-es")}
                  {textField("descEs", t("staff.badges.descriptionEs"), "data-badge-desc-es")}
                  {textField("fr", t("staff.badges.labelFr"), "data-badge-label-fr")}
                  {textField("descFr", t("staff.badges.descriptionFr"), "data-badge-desc-fr")}
                  <div className="form-grid">
                    <Field label={t("staff.badges.rule")}>
                      {({ id }) => (
                        <Select
                          id={id}
                          data-badge-rule
                          value={draft.ruleType}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, ruleType: event.target.value }))
                          }
                        >
                          <option value="">{t("staff.badges.manual")}</option>
                          {RULE_TYPES.map((type) => (
                            <option key={type} value={type}>
                              <RuleLabel type={type} />
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    {draft.ruleType === "" ? null : (
                      <Field label={t("staff.badges.threshold")}>
                        {({ id }) => (
                          <TextInput
                            id={id}
                            type="number"
                            min={0}
                            data-badge-threshold
                            value={draft.threshold}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                threshold: Number(event.target.value),
                              }))
                            }
                          />
                        )}
                      </Field>
                    )}
                    {draft.ruleType === "posts_in_forum"
                      ? textField("forumId", t("staff.badges.forumId"), "data-badge-forum")
                      : null}
                  </div>
                  <FormActions>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(false);
                        setDraft(EMPTY);
                      }}
                    >
                      {t("staff.badges.cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      data-badge-save
                      disabled={mutate.isPending}
                      onClick={save}
                    >
                      {t("staff.badges.save")}
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
        titleKey="staff.badges.confirmDelete.title"
        bodyKey="staff.badges.confirmDelete.body"
        confirmLabelKey="staff.badges.delete"
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
