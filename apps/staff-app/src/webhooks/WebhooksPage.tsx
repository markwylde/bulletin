import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  IconPlus,
  IconRefresh,
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
  type Tone,
} from "../ui/index.ts";

interface ServiceMember {
  readonly id: string;
  readonly name: string | null;
}

interface WebhookRow {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly principalMemberId: string;
  readonly principalName: string | null;
  readonly contentFields: readonly string[];
  readonly enabled: boolean;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly lastDeliveryAt: string | null;
  readonly lastDeliveryStatus: string | null;
}

interface DeliveryRow {
  readonly id: string;
  readonly webhookId: string;
  readonly attempt: number;
  readonly status: "pending" | "delivered" | "failed" | "skipped";
  readonly httpStatus: number | null;
  readonly responseMs: number | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly eventType: string;
  readonly webhookUrl: string;
}

interface WebhooksView {
  readonly webhooks: readonly WebhookRow[];
  readonly deliveries: readonly DeliveryRow[];
  readonly serviceMembers: readonly ServiceMember[];
  readonly events: readonly string[];
  readonly contentFields: readonly string[];
}

interface Draft {
  readonly id: string | null;
  readonly url: string;
  readonly principalMemberId: string;
  readonly events: readonly string[];
  readonly contentFields: readonly string[];
  readonly enabled: boolean;
}

const EMPTY: Draft = {
  id: null,
  url: "",
  principalMemberId: "",
  events: [],
  contentFields: [],
  enabled: true,
};

const EVENT_LABELS: Readonly<Record<string, { readonly labelKey: string }>> = {
  "topic.created": { labelKey: "staff.webhooks.event.topic.created" },
  "post.created": { labelKey: "staff.webhooks.event.post.created" },
  "post.edited": { labelKey: "staff.webhooks.event.post.edited" },
  "post.deleted": { labelKey: "staff.webhooks.event.post.deleted" },
  "post.restored": { labelKey: "staff.webhooks.event.post.restored" },
  "post.approved": { labelKey: "staff.webhooks.event.post.approved" },
  "reaction.added": { labelKey: "staff.webhooks.event.reaction.added" },
};

const CONTENT_LABELS: Readonly<Record<string, { readonly labelKey: string }>> = {
  title: { labelKey: "staff.webhooks.content.title" },
  bodyMd: { labelKey: "staff.webhooks.content.bodyMd" },
  bodyHtml: { labelKey: "staff.webhooks.content.bodyHtml" },
  bodyText: { labelKey: "staff.webhooks.content.bodyText" },
};

const STATUS_LABELS: Readonly<Record<string, { readonly labelKey: string }>> = {
  pending: { labelKey: "staff.webhooks.status.pending" },
  delivered: { labelKey: "staff.webhooks.status.delivered" },
  failed: { labelKey: "staff.webhooks.status.failed" },
  skipped: { labelKey: "staff.webhooks.status.skipped" },
};

function labelKey(
  labels: Readonly<Record<string, { readonly labelKey: string }>>,
  value: string,
): string {
  return labels[value]?.labelKey ?? value;
}

function toggle(values: readonly string[], value: string, checked: boolean): readonly string[] {
  return checked ? [...new Set([...values, value])] : values.filter((entry) => entry !== value);
}

function statusTone(status: string): Tone {
  switch (status) {
    case "delivered":
      return "success";
    case "failed":
      return "danger";
    case "pending":
      return "warning";
    default:
      return "neutral";
  }
}

export function WebhooksPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [secret, setSecret] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["staff", "webhooks"],
    queryFn: () => apiGet<WebhooksView>("/api/staff/webhooks"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPost<Record<string, unknown>>("/api/staff/webhooks", body),
    onSuccess: (data, body) => {
      if (typeof data.secret === "string") {
        setSecret(data.secret);
      }

      if (body.action === "save") {
        setDraft((current) => ({ ...EMPTY, principalMemberId: current.principalMemberId }));
      }

      toast.pushToast({
        messageKey:
          body.action === "redeliver" ? "staff.webhooks.redelivered" : "staff.webhooks.saved",
        tone: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["staff", "webhooks"] });
    },
    onError: (error: unknown) => {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      toast.pushToast({
        messageKey:
          code === "invalid_target" ? "staff.webhooks.invalidTarget" : "staff.webhooks.saveError",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (query.data !== undefined && draft.principalMemberId === "") {
      const first = query.data.serviceMembers[0];
      setDraft((current) => ({
        ...current,
        principalMemberId: first?.id ?? "",
        events: current.events.length === 0 ? query.data.events.slice(0, 1) : current.events,
      }));
    }
  }, [query.data, draft.principalMemberId]);

  const edit = (webhook: WebhookRow): void => {
    setSecret(null);
    setDraft({
      id: webhook.id,
      url: webhook.url,
      principalMemberId: webhook.principalMemberId,
      events: webhook.events,
      contentFields: webhook.contentFields,
      enabled: webhook.enabled,
    });
  };

  const canSave =
    draft.url.trim() !== "" &&
    draft.principalMemberId !== "" &&
    draft.events.length > 0 &&
    !mutate.isPending;

  return (
    <Page
      id="webhooks"
      title={t("staff.webhooks.title")}
      description={t("staff.webhooks.intro")}
      actions={
        <Button
          icon={<IconPlus size={16} />}
          data-webhook-new
          onClick={() =>
            setDraft((current) => ({ ...EMPTY, principalMemberId: current.principalMemberId }))
          }
        >
          {t("staff.webhooks.new")}
        </Button>
      }
    >
      {secret === null ? null : (
        <Notice
          tone="warning"
          role="status"
          data-webhook-secret
          title={t("staff.webhooks.secretOnce")}
          action={
            <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>
              {t("staff.apiKeys.dismissSecret")}
            </Button>
          }
        >
          <code className="mono break">{secret}</code>
        </Notice>
      )}

      <QueryState query={query} errorLabel={t("staff.webhooks.loadError")}>
        {(data) => (
          <>
            <Panel flush title={t("staff.webhooks.list.title")}>
              <Table
                caption={t("staff.webhooks.list.title")}
                rows={data.webhooks}
                rowKey={(webhook) => webhook.id}
                rowProps={(webhook) => ({
                  "data-webhook-row": webhook.id,
                  className: webhook.id === draft.id ? "is-selected" : undefined,
                })}
                empty={<EmptyState title={t("staff.webhooks.empty")} />}
                columns={[
                  {
                    id: "url",
                    header: t("staff.webhooks.url"),
                    primary: true,
                    cell: (webhook) => (
                      <span className="stack stack-xs">
                        <span className="mono break">{webhook.url}</span>
                        <span className="subtle">
                          {webhook.events
                            .map((event) => t(labelKey(EVENT_LABELS, event)))
                            .join(", ")}
                        </span>
                      </span>
                    ),
                  },
                  {
                    id: "principal",
                    header: t("staff.webhooks.principal"),
                    cell: (webhook) => webhook.principalName ?? "—",
                  },
                  {
                    id: "enabled",
                    header: t("staff.webhooks.enabled"),
                    cell: (webhook) =>
                      webhook.enabled ? (
                        <Badge tone="success" dot>
                          {t("staff.webhooks.enabled.yes")}
                        </Badge>
                      ) : (
                        <Badge tone={webhook.disabledReason === null ? "neutral" : "warning"}>
                          {webhook.disabledReason === null
                            ? t("staff.webhooks.enabled.no")
                            : t("staff.webhooks.disabled")}
                        </Badge>
                      ),
                  },
                  {
                    id: "lastDelivery",
                    header: t("staff.webhooks.lastDelivery"),
                    cell: (webhook) =>
                      webhook.lastDeliveryStatus === null ? (
                        <span className="subtle">—</span>
                      ) : (
                        <Badge tone={statusTone(webhook.lastDeliveryStatus)}>
                          {t(labelKey(STATUS_LABELS, webhook.lastDeliveryStatus))}
                        </Badge>
                      ),
                  },
                  {
                    id: "actions",
                    header: t("staff.rowActions"),
                    align: "end",
                    width: "5.5rem",
                    cell: (webhook) => (
                      <span className="cluster cluster-end">
                        <IconButton
                          size="sm"
                          label={t("staff.webhooks.edit")}
                          data-webhook-edit={webhook.id}
                          onClick={() => edit(webhook)}
                        >
                          <IconEdit size={16} />
                        </IconButton>
                        <RowActions label={t("staff.rowActions")}>
                          <MenuItem
                            data-webhook-toggle={webhook.id}
                            disabled={mutate.isPending}
                            onClick={() =>
                              mutate.mutate({
                                action: "toggle",
                                id: webhook.id,
                                enabled: !webhook.enabled,
                              })
                            }
                          >
                            {webhook.enabled
                              ? t("staff.webhooks.disable")
                              : t("staff.webhooks.enable")}
                          </MenuItem>
                          <MenuItem
                            tone="danger"
                            icon={<IconTrash size={16} />}
                            data-webhook-delete={webhook.id}
                            disabled={mutate.isPending}
                            onClick={() => setDeleteId(webhook.id)}
                          >
                            {t("staff.webhooks.delete")}
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
                  ? t("staff.webhooks.form.title")
                  : t("staff.webhooks.form.editTitle")
              }
              data-webhook-editor
            >
              <div className="stack">
                <div className="form-grid">
                  <Field label={t("staff.webhooks.url")}>
                    {({ id }) => (
                      <TextInput
                        id={id}
                        data-webhook-url
                        type="url"
                        placeholder="https://"
                        value={draft.url}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, url: event.target.value }))
                        }
                      />
                    )}
                  </Field>
                  <Field label={t("staff.webhooks.principal")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        data-webhook-principal
                        value={draft.principalMemberId}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            principalMemberId: event.target.value,
                          }))
                        }
                      >
                        {data.serviceMembers.length === 0 ? (
                          <option value="">{t("staff.webhooks.principalEmpty")}</option>
                        ) : null}
                        {data.serviceMembers.map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.name ?? member.id}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
                <fieldset className="field-group" data-webhook-events>
                  <legend>{t("staff.webhooks.events")}</legend>
                  <div className="check-grid">
                    {data.events.map((event) => (
                      <Checkbox
                        key={event}
                        label={t(labelKey(EVENT_LABELS, event))}
                        data-webhook-event={event}
                        checked={draft.events.includes(event)}
                        onChange={(input) =>
                          setDraft((current) => ({
                            ...current,
                            events: toggle(current.events, event, input.target.checked),
                          }))
                        }
                      />
                    ))}
                  </div>
                </fieldset>
                <fieldset className="field-group" data-webhook-content>
                  <legend>{t("staff.webhooks.contentFields")}</legend>
                  <div className="check-grid">
                    {data.contentFields.map((field) => (
                      <Checkbox
                        key={field}
                        label={t(labelKey(CONTENT_LABELS, field))}
                        data-webhook-content-field={field}
                        checked={draft.contentFields.includes(field)}
                        onChange={(input) =>
                          setDraft((current) => ({
                            ...current,
                            contentFields: toggle(
                              current.contentFields,
                              field,
                              input.target.checked,
                            ),
                          }))
                        }
                      />
                    ))}
                  </div>
                </fieldset>
                <Switch
                  data-webhook-enabled
                  label={t("staff.webhooks.enabled")}
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                <FormActions>
                  <Button
                    variant="primary"
                    data-webhook-save
                    disabled={!canSave}
                    onClick={() =>
                      mutate.mutate({
                        action: "save",
                        ...(draft.id === null ? {} : { id: draft.id }),
                        url: draft.url,
                        principalMemberId: draft.principalMemberId,
                        events: draft.events,
                        contentFields: draft.contentFields,
                        enabled: draft.enabled,
                      })
                    }
                  >
                    {t("staff.webhooks.save")}
                  </Button>
                </FormActions>
              </div>
            </Panel>

            <Panel flush title={t("staff.webhooks.deliveries.title")}>
              <Table
                caption={t("staff.webhooks.deliveries.title")}
                rows={data.deliveries}
                rowKey={(delivery) => delivery.id}
                rowProps={(delivery) => ({ "data-webhook-delivery": delivery.id })}
                empty={<EmptyState title={t("staff.webhooks.deliveries.empty")} />}
                columns={[
                  {
                    id: "event",
                    header: t("staff.webhooks.deliveries.event"),
                    primary: true,
                    cell: (delivery) => <code className="mono">{delivery.eventType}</code>,
                  },
                  {
                    id: "status",
                    header: t("staff.webhooks.deliveries.status"),
                    cell: (delivery) => (
                      <span className="stack stack-xs">
                        <Badge tone={statusTone(delivery.status)}>
                          {t(labelKey(STATUS_LABELS, delivery.status))}
                        </Badge>
                        {delivery.error === null ? null : (
                          <span className="subtle break">{delivery.error}</span>
                        )}
                      </span>
                    ),
                  },
                  {
                    id: "attempt",
                    header: t("staff.webhooks.deliveries.attempt"),
                    align: "end",
                    cell: (delivery) => delivery.attempt,
                  },
                  {
                    id: "http",
                    header: t("staff.webhooks.deliveries.httpStatus"),
                    align: "end",
                    cell: (delivery) => delivery.httpStatus ?? "—",
                  },
                  {
                    id: "ms",
                    header: t("staff.webhooks.deliveries.responseMs"),
                    align: "end",
                    cell: (delivery) =>
                      delivery.responseMs === null ? "—" : `${delivery.responseMs} ms`,
                  },
                  {
                    id: "actions",
                    header: t("staff.rowActions"),
                    align: "end",
                    width: "3rem",
                    cell: (delivery) => (
                      <IconButton
                        size="sm"
                        label={t("staff.webhooks.redeliver")}
                        data-webhook-redeliver={delivery.id}
                        disabled={mutate.isPending}
                        onClick={() =>
                          mutate.mutate({ action: "redeliver", deliveryId: delivery.id })
                        }
                      >
                        <IconRefresh size={16} />
                      </IconButton>
                    ),
                  },
                ]}
              />
            </Panel>
          </>
        )}
      </QueryState>

      <ConfirmDialog
        open={deleteId !== null}
        titleKey="staff.webhooks.confirmDelete.title"
        bodyKey="staff.webhooks.confirmDelete.body"
        confirmLabelKey="staff.webhooks.delete"
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
