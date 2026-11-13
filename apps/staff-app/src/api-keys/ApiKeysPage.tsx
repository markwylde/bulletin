import { useT } from "@bulletin/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface IntegrationKey {
  readonly id: string;
  readonly prefix: string;
  readonly label: string;
  readonly principalName: string | null;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
}

interface GroupOption {
  readonly id: string;
  readonly title: string;
}

interface KeysView {
  readonly keys: readonly IntegrationKey[];
  readonly groups: readonly GroupOption[];
  readonly scopes: readonly string[];
}

const SCOPE_LABELS: Readonly<Record<string, { readonly labelKey: string }>> = {
  "read:forums": { labelKey: "staff.apiKeys.scope.readForums" },
  "read:topics": { labelKey: "staff.apiKeys.scope.readTopics" },
  "read:posts": { labelKey: "staff.apiKeys.scope.readPosts" },
  "read:members": { labelKey: "staff.apiKeys.scope.readMembers" },
  "read:search": { labelKey: "staff.apiKeys.scope.readSearch" },
  "write:posts": { labelKey: "staff.apiKeys.scope.writePosts" },
  "write:reactions": { labelKey: "staff.apiKeys.scope.writeReactions" },
  "write:follows": { labelKey: "staff.apiKeys.scope.writeFollows" },
};

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope]?.labelKey ?? scope;
}

function toggle(values: readonly string[], value: string, checked: boolean): readonly string[] {
  return checked ? [...new Set([...values, value])] : values.filter((entry) => entry !== value);
}

function formatDate(value: string | null): string {
  return value === null ? "—" : new Date(value).toLocaleString();
}

export function ApiKeysPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [groupIds, setGroupIds] = useState<readonly string[]>([]);
  const [scopes, setScopes] = useState<readonly string[]>(["read:forums"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["staff", "api-keys"],
    queryFn: () => apiGet<KeysView>("/api/staff/api-keys"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPost<Record<string, unknown>>("/api/staff/api-keys", body),
    onSuccess: (data, body) => {
      if (typeof data.key === "string") {
        setSecret(data.key);
      }

      setMessage(body.action === "revoke" ? t("staff.apiKeys.revoked") : t("staff.apiKeys.saved"));

      if (body.action === "create") {
        setLabel("");
        setExpiresAt("");
      }

      void queryClient.invalidateQueries({ queryKey: ["staff", "api-keys"] });
    },
    onError: (error: unknown) => {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      setMessage(
        code === "display_name_taken"
          ? t("staff.apiKeys.displayNameTaken")
          : t("staff.apiKeys.saveError"),
      );
    },
  });

  const groups = query.data?.groups ?? [];
  const availableScopes = query.data?.scopes ?? [];
  const canCreate =
    label.trim().length >= 3 && groupIds.length > 0 && scopes.length > 0 && !mutate.isPending;

  return (
    <div className="page" data-page="api-keys">
      <header className="page-header">
        <h1>{t("staff.apiKeys.title")}</h1>
        <p>{t("staff.apiKeys.intro")}</p>
      </header>

      {message === null ? null : (
        <p className="widget-muted" role="status" data-api-key-message>
          {message}
        </p>
      )}
      {secret === null ? null : (
        <div className="widget-error" role="status" data-api-key-secret>
          <p>{t("staff.apiKeys.secretOnce")}</p>
          <code data-api-key-secret-value>{secret}</code>
        </div>
      )}

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.apiKeys.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <>
          <section className="admin-panel" aria-labelledby="api-keys-list-title">
            <h2 id="api-keys-list-title">{t("staff.apiKeys.list.title")}</h2>
            <div className="matrix-scroll" data-matrix-scroll>
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th scope="col">{t("staff.apiKeys.prefix")}</th>
                    <th scope="col">{t("staff.apiKeys.principal")}</th>
                    <th scope="col">{t("staff.apiKeys.scopes")}</th>
                    <th scope="col">{t("staff.apiKeys.lastUsed")}</th>
                    <th scope="col">{t("staff.apiKeys.status")}</th>
                    <th scope="col">{t("staff.apiKeys.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.keys.map((key) => (
                    <tr key={key.id} data-api-key-row={key.id}>
                      <td data-label={t("staff.apiKeys.prefix")}>
                        <code>{`blt_${key.prefix}_…`}</code>
                      </td>
                      <td data-label={t("staff.apiKeys.principal")}>
                        {key.principalName ?? key.label}
                      </td>
                      <td data-label={t("staff.apiKeys.scopes")}>
                        {key.scopes.map((scope) => t(scopeLabel(scope))).join(", ")}
                      </td>
                      <td data-label={t("staff.apiKeys.lastUsed")}>{formatDate(key.lastUsedAt)}</td>
                      <td data-label={t("staff.apiKeys.status")}>
                        {key.revokedAt === null
                          ? t("staff.apiKeys.active")
                          : t("staff.apiKeys.revoked")}
                      </td>
                      <td data-label={t("staff.apiKeys.actions")}>
                        <button
                          type="button"
                          data-api-key-revoke={key.id}
                          disabled={mutate.isPending || key.revokedAt !== null}
                          onClick={() => mutate.mutate({ action: "revoke", id: key.id })}
                        >
                          {t("staff.apiKeys.revoke")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="admin-panel" data-api-key-editor>
            <h2>{t("staff.apiKeys.form.title")}</h2>
            <div className="admin-form">
              <label>
                <span>{t("staff.apiKeys.label")}</span>
                <input
                  data-api-key-label
                  value={label}
                  maxLength={32}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label>
                <span>{t("staff.apiKeys.expires")}</span>
                <input
                  data-api-key-expiry
                  type="date"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </label>
            </div>

            <fieldset className="admin-form" data-api-key-groups>
              <legend>{t("staff.apiKeys.groups")}</legend>
              {groups.map((group) => (
                <label key={group.id}>
                  <input
                    type="checkbox"
                    data-api-key-group={group.id}
                    checked={groupIds.includes(group.id)}
                    onChange={(input) =>
                      setGroupIds((current) => toggle(current, group.id, input.target.checked))
                    }
                  />
                  <span>{group.title}</span>
                </label>
              ))}
            </fieldset>

            <fieldset className="admin-form" data-api-key-scopes>
              <legend>{t("staff.apiKeys.scopes")}</legend>
              {availableScopes.map((scope) => (
                <label key={scope}>
                  <input
                    type="checkbox"
                    data-api-key-scope={scope}
                    checked={scopes.includes(scope)}
                    onChange={(input) =>
                      setScopes((current) => toggle(current, scope, input.target.checked))
                    }
                  />
                  <span>{t(scopeLabel(scope))}</span>
                </label>
              ))}
            </fieldset>

            <div className="admin-form">
              <button
                type="button"
                data-api-key-create
                disabled={!canCreate}
                onClick={() =>
                  mutate.mutate({
                    action: "create",
                    label,
                    groupIds,
                    scopes,
                    ...(expiresAt === "" ? {} : { expiresAt: `${expiresAt}T00:00:00.000Z` }),
                  })
                }
              >
                {t("staff.apiKeys.create")}
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
