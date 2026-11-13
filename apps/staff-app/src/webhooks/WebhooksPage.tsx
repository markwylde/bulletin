import { useT } from "@bulletin/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

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

export function WebhooksPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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
        setDraft(EMPTY);
        setMessage(t("staff.webhooks.saved"));
      } else if (body.action === "redeliver") {
        setMessage(t("staff.webhooks.redelivered"));
      } else {
        setMessage(t("staff.webhooks.saved"));
      }

      void queryClient.invalidateQueries({ queryKey: ["staff", "webhooks"] });
    },
    onError: (error: unknown) => {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      setMessage(
        code === "invalid_target"
          ? t("staff.webhooks.invalidTarget")
          : t("staff.webhooks.saveError"),
      );
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
    setMessage(null);
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
    <div className="page" data-page="webhooks">
      <header className="page-header">
        <h1>{t("staff.webhooks.title")}</h1>
        <p>{t("staff.webhooks.intro")}</p>
      </header>

      {message === null ? null : (
        <p className="widget-muted" role="status" data-webhook-message>
          {message}
        </p>
      )}
      {secret === null ? null : (
        <div className="widget-error" role="status" data-webhook-secret>
          <p>{t("staff.webhooks.secretOnce")}</p>
          <code>{secret}</code>
        </div>
      )}

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.webhooks.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <>
          <section className="admin-panel" aria-labelledby="webhooks-list-title">
            <h2 id="webhooks-list-title">{t("staff.webhooks.list.title")}</h2>
            <div className="matrix-scroll" data-matrix-scroll>
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th scope="col">{t("staff.webhooks.url")}</th>
                    <th scope="col">{t("staff.webhooks.principal")}</th>
                    <th scope="col">{t("staff.webhooks.events")}</th>
                    <th scope="col">{t("staff.webhooks.enabled")}</th>
                    <th scope="col">{t("staff.webhooks.lastDelivery")}</th>
                    <th scope="col">{t("staff.webhooks.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.webhooks.map((webhook) => (
                    <tr key={webhook.id} data-webhook-row={webhook.id}>
                      <td data-label={t("staff.webhooks.url")}>{webhook.url}</td>
                      <td data-label={t("staff.webhooks.principal")}>
                        {webhook.principalName ?? "—"}
                      </td>
                      <td data-label={t("staff.webhooks.events")}>
                        {webhook.events.map((event) => t(labelKey(EVENT_LABELS, event))).join(", ")}
                      </td>
                      <td data-label={t("staff.webhooks.enabled")}>
                        {webhook.enabled
                          ? t("staff.webhooks.enabled.yes")
                          : t("staff.webhooks.enabled.no")}
                        {webhook.disabledReason === null ? null : (
                          <span className="widget-muted"> ({t("staff.webhooks.disabled")})</span>
                        )}
                      </td>
                      <td data-label={t("staff.webhooks.lastDelivery")}>
                        {webhook.lastDeliveryStatus === null
                          ? "—"
                          : t(labelKey(STATUS_LABELS, webhook.lastDeliveryStatus))}
                      </td>
                      <td data-label={t("staff.webhooks.actions")}>
                        <button
                          type="button"
                          data-webhook-edit={webhook.id}
                          onClick={() => edit(webhook)}
                        >
                          {t("staff.webhooks.edit")}
                        </button>
                        <button
                          type="button"
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
                        </button>
                        <button
                          type="button"
                          data-webhook-delete={webhook.id}
                          disabled={mutate.isPending}
                          onClick={() => mutate.mutate({ action: "delete", id: webhook.id })}
                        >
                          {t("staff.webhooks.delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" data-webhook-new onClick={() => setDraft(EMPTY)}>
              {t("staff.webhooks.new")}
            </button>
          </section>

          <section className="admin-panel" data-webhook-editor>
            <h2>{t("staff.webhooks.form.title")}</h2>
            <div className="admin-form">
              <label>
                <span>{t("staff.webhooks.url")}</span>
                <input
                  data-webhook-url
                  type="url"
                  value={draft.url}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, url: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t("staff.webhooks.principal")}</span>
                <select
                  data-webhook-principal
                  value={draft.principalMemberId}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, principalMemberId: event.target.value }))
                  }
                >
                  {query.data.serviceMembers.length === 0 ? (
                    <option value="">{t("staff.webhooks.principalEmpty")}</option>
                  ) : null}
                  {query.data.serviceMembers.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name ?? member.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className="admin-form" data-webhook-events>
              <legend>{t("staff.webhooks.events")}</legend>
              {query.data.events.map((event) => (
                <label key={event}>
                  <input
                    type="checkbox"
                    data-webhook-event={event}
                    checked={draft.events.includes(event)}
                    onChange={(input) =>
                      setDraft((current) => ({
                        ...current,
                        events: toggle(current.events, event, input.target.checked),
                      }))
                    }
                  />
                  <span>{t(labelKey(EVENT_LABELS, event))}</span>
                </label>
              ))}
            </fieldset>
            <fieldset className="admin-form" data-webhook-content>
              <legend>{t("staff.webhooks.contentFields")}</legend>
              {query.data.contentFields.map((field) => (
                <label key={field}>
                  <input
                    type="checkbox"
                    data-webhook-content-field={field}
                    checked={draft.contentFields.includes(field)}
                    onChange={(input) =>
                      setDraft((current) => ({
                        ...current,
                        contentFields: toggle(current.contentFields, field, input.target.checked),
                      }))
                    }
                  />
                  <span>{t(labelKey(CONTENT_LABELS, field))}</span>
                </label>
              ))}
            </fieldset>
            <div className="admin-form">
              <label>
                <input
                  type="checkbox"
                  data-webhook-enabled
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                <span>{t("staff.webhooks.enabled")}</span>
              </label>
              <button
                type="button"
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
              </button>
            </div>
          </section>

          <section className="admin-panel" aria-labelledby="webhook-deliveries-title">
            <h2 id="webhook-deliveries-title">{t("staff.webhooks.deliveries.title")}</h2>
            <div className="matrix-scroll" data-matrix-scroll>
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th scope="col">{t("staff.webhooks.deliveries.event")}</th>
                    <th scope="col">{t("staff.webhooks.deliveries.attempt")}</th>
                    <th scope="col">{t("staff.webhooks.deliveries.status")}</th>
                    <th scope="col">{t("staff.webhooks.deliveries.httpStatus")}</th>
                    <th scope="col">{t("staff.webhooks.deliveries.responseMs")}</th>
                    <th scope="col">{t("staff.webhooks.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.deliveries.map((delivery) => (
                    <tr key={delivery.id} data-webhook-delivery={delivery.id}>
                      <td data-label={t("staff.webhooks.deliveries.event")}>
                        {delivery.eventType}
                      </td>
                      <td data-label={t("staff.webhooks.deliveries.attempt")}>
                        {delivery.attempt}
                      </td>
                      <td data-label={t("staff.webhooks.deliveries.status")}>
                        {t(labelKey(STATUS_LABELS, delivery.status))}
                        {delivery.error === null ? null : (
                          <span className="widget-muted"> {delivery.error}</span>
                        )}
                      </td>
                      <td data-label={t("staff.webhooks.deliveries.httpStatus")}>
                        {delivery.httpStatus ?? "—"}
                      </td>
                      <td data-label={t("staff.webhooks.deliveries.responseMs")}>
                        {delivery.responseMs === null ? "—" : `${delivery.responseMs} ms`}
                      </td>
                      <td data-label={t("staff.webhooks.actions")}>
                        <button
                          type="button"
                          data-webhook-redeliver={delivery.id}
                          disabled={mutate.isPending}
                          onClick={() =>
                            mutate.mutate({ action: "redeliver", deliveryId: delivery.id })
                          }
                        >
                          {t("staff.webhooks.redeliver")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
