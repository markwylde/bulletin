import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormActions,
  IconPlus,
  IconTrash,
  MenuItem,
  Notice,
  Page,
  Panel,
  QueryState,
  RowActions,
  Table,
  TextInput,
} from "../ui/index.ts";

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
  const toast = useToast();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [groupIds, setGroupIds] = useState<readonly string[]>([]);
  const [scopes, setScopes] = useState<readonly string[]>(["read:forums"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
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

      toast.pushToast({
        messageKey: body.action === "revoke" ? "staff.apiKeys.revoked" : "staff.apiKeys.saved",
        tone: "success",
      });

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
      toast.pushToast({
        messageKey:
          code === "display_name_taken"
            ? "staff.apiKeys.displayNameTaken"
            : "staff.apiKeys.saveError",
        tone: "error",
      });
    },
  });

  const groups = query.data?.groups ?? [];
  const availableScopes = query.data?.scopes ?? [];
  const canCreate =
    label.trim().length >= 3 && groupIds.length > 0 && scopes.length > 0 && !mutate.isPending;

  return (
    <Page id="api-keys" title={t("staff.apiKeys.title")} description={t("staff.apiKeys.intro")}>
      {secret === null ? null : (
        <Notice
          tone="warning"
          role="status"
          data-api-key-secret
          title={t("staff.apiKeys.secretOnce")}
          action={
            <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>
              {t("staff.apiKeys.dismissSecret")}
            </Button>
          }
        >
          <code className="mono break" data-api-key-secret-value>
            {secret}
          </code>
        </Notice>
      )}

      <QueryState query={query} errorLabel={t("staff.apiKeys.loadError")}>
        {(data) => (
          <Panel flush title={t("staff.apiKeys.list.title")}>
            <Table
              caption={t("staff.apiKeys.list.title")}
              rows={data.keys}
              rowKey={(key) => key.id}
              rowProps={(key) => ({ "data-api-key-row": key.id })}
              empty={<EmptyState title={t("staff.apiKeys.empty")} />}
              columns={[
                {
                  id: "principal",
                  header: t("staff.apiKeys.principal"),
                  primary: true,
                  cell: (key) => (
                    <span className="stack stack-xs">
                      <span>{key.principalName ?? key.label}</span>
                      <code className="mono subtle">{`blt_${key.prefix}_…`}</code>
                    </span>
                  ),
                },
                {
                  id: "scopes",
                  header: t("staff.apiKeys.scopes"),
                  cell: (key) => (
                    <span className="cluster">
                      {key.scopes.map((scope) => (
                        <Badge key={scope}>{t(scopeLabel(scope))}</Badge>
                      ))}
                    </span>
                  ),
                },
                {
                  id: "lastUsed",
                  header: t("staff.apiKeys.lastUsed"),
                  cell: (key) => formatDate(key.lastUsedAt),
                },
                {
                  id: "status",
                  header: t("staff.apiKeys.status"),
                  cell: (key) =>
                    key.revokedAt === null ? (
                      <Badge tone="success" dot>
                        {t("staff.apiKeys.active")}
                      </Badge>
                    ) : (
                      <Badge>{t("staff.apiKeys.revoked")}</Badge>
                    ),
                },
                {
                  id: "actions",
                  header: t("staff.rowActions"),
                  align: "end",
                  width: "3rem",
                  cell: (key) => (
                    <RowActions label={t("staff.rowActions")}>
                      <MenuItem
                        tone="danger"
                        icon={<IconTrash size={16} />}
                        data-api-key-revoke={key.id}
                        disabled={mutate.isPending || key.revokedAt !== null}
                        onClick={() => setRevokeId(key.id)}
                      >
                        {t("staff.apiKeys.revoke")}
                      </MenuItem>
                    </RowActions>
                  ),
                },
              ]}
            />
          </Panel>
        )}
      </QueryState>

      {query.isSuccess ? (
        <Panel title={t("staff.apiKeys.form.title")} data-api-key-editor>
          <div className="stack">
            <div className="form-grid">
              <Field label={t("staff.apiKeys.label")}>
                {({ id }) => (
                  <TextInput
                    id={id}
                    data-api-key-label
                    value={label}
                    maxLength={32}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                )}
              </Field>
              <Field label={t("staff.apiKeys.expires")}>
                {({ id }) => (
                  <TextInput
                    id={id}
                    data-api-key-expiry
                    type="date"
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                )}
              </Field>
            </div>

            <fieldset className="field-group" data-api-key-groups>
              <legend>{t("staff.apiKeys.groups")}</legend>
              <div className="check-grid">
                {groups.map((group) => (
                  <Checkbox
                    key={group.id}
                    label={group.title}
                    data-api-key-group={group.id}
                    checked={groupIds.includes(group.id)}
                    onChange={(input) =>
                      setGroupIds((current) => toggle(current, group.id, input.target.checked))
                    }
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="field-group" data-api-key-scopes>
              <legend>{t("staff.apiKeys.scopes")}</legend>
              <div className="check-grid">
                {availableScopes.map((scope) => (
                  <Checkbox
                    key={scope}
                    label={t(scopeLabel(scope))}
                    data-api-key-scope={scope}
                    checked={scopes.includes(scope)}
                    onChange={(input) =>
                      setScopes((current) => toggle(current, scope, input.target.checked))
                    }
                  />
                ))}
              </div>
            </fieldset>

            <FormActions>
              <Button
                variant="primary"
                icon={<IconPlus size={16} />}
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
              </Button>
            </FormActions>
          </div>
        </Panel>
      ) : null}

      <ConfirmDialog
        open={revokeId !== null}
        titleKey="staff.apiKeys.confirmRevoke.title"
        bodyKey="staff.apiKeys.confirmRevoke.body"
        confirmLabelKey="staff.apiKeys.revoke"
        tone="danger"
        busy={mutate.isPending}
        onCancel={() => setRevokeId(null)}
        onConfirm={() => {
          const id = revokeId;
          setRevokeId(null);

          if (id !== null) {
            mutate.mutate({ action: "revoke", id });
          }
        }}
      />
    </Page>
  );
}
