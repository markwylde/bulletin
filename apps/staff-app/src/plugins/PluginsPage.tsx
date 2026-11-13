import { useT } from "@bulletin/ui";
import { type FormDefinition, FormRenderer, type FormValues } from "@bulletin/ui/forms";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

function capabilityLabel(t: ReturnType<typeof useT>, capability: Capability): string {
  switch (capability.capability) {
    case "core.read":
      return t("staff.plugins.capability.core_read");
    case "core.write":
      return t("staff.plugins.capability.core_write");
    case "events":
      return t("staff.plugins.capability.events");
    case "jobs":
      return t("staff.plugins.capability.jobs");
    case "kv":
      return t("staff.plugins.capability.kv");
    case "egress":
      return t("staff.plugins.capability.egress");
    case "template":
      return t("staff.plugins.capability.template");
    case "enricher":
      return t("staff.plugins.capability.enricher");
    case "filter":
      return t("staff.plugins.capability.filter");
    case "veto":
      return t("staff.plugins.capability.veto");
    case "route":
      return t("staff.plugins.capability.route");
    case "client":
      return t("staff.plugins.capability.client");
    case "settings":
      return t("staff.plugins.capability.settings");
    case "pii":
      return t("staff.plugins.capability.pii");
    case "gdpr":
      return t("staff.plugins.capability.gdpr");
    default:
      return capability.capability.startsWith("egress:")
        ? t("staff.plugins.capability.egressHost")
        : capability.capability;
  }
}

function tabLabel(t: ReturnType<typeof useT>, tab: PluginTab): string {
  switch (tab) {
    case "settings":
      return t("staff.plugins.tab.settings");
    case "health":
      return t("staff.plugins.tab.health");
    case "errors":
      return t("staff.plugins.tab.errors");
  }
}

interface Capability {
  readonly capability: string;
  readonly labelKey: string;
  readonly elevated: boolean;
}

interface BreakerRow {
  readonly hook: string;
  readonly failures: number;
  readonly disabledAt: string | null;
}

interface PluginError {
  readonly step: string;
  readonly state: string;
  readonly error: string | null;
  readonly createdAt: string;
}

interface StaffPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly state: string;
  readonly enabled: boolean;
  readonly generation: number;
  readonly capabilities: readonly Capability[];
  readonly servicePrincipal: {
    readonly group: string;
    readonly elevatedForumIds: readonly string[];
    readonly warningKey: string | null;
  };
  readonly timings: Readonly<Record<string, number>>;
  readonly breaker: readonly BreakerRow[];
  readonly errors: readonly PluginError[];
}

interface PluginSettings {
  readonly definition: FormDefinition;
  readonly values: FormValues;
}

type PluginTab = "settings" | "health" | "errors";

export function PluginsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<PluginTab>("settings");
  const [values, setValues] = useState<FormValues>({});
  const [message, setMessage] = useState<string | null>(null);

  const plugins = useQuery({
    queryKey: ["staff", "plugins"],
    queryFn: () => apiGet<{ plugins: readonly StaffPlugin[] }>("/api/staff/plugins"),
  });
  const settings = useQuery({
    queryKey: ["staff", "plugins", selected, "settings"],
    queryFn: () => apiGet<PluginSettings>(`/api/staff/plugins/settings?pluginId=${selected ?? ""}`),
    enabled: selected !== null,
  });

  useEffect(() => {
    if (settings.data !== undefined) {
      setValues(settings.data.values);
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (next: FormValues) =>
      apiPost("/api/staff/plugins/settings", { pluginId: selected, values: next }),
    onSuccess: () => {
      setMessage(t("staff.plugins.saved"));
      void queryClient.invalidateQueries({ queryKey: ["staff", "plugins"] });
    },
    onError: () => setMessage(t("staff.plugins.saveFailed")),
  });
  const uninstall = useMutation({
    mutationFn: (pluginId: string) =>
      apiPost("/api/staff/plugins/uninstall", { pluginId, dataAction: "keep" }),
    onSuccess: () => {
      setMessage(t("staff.plugins.uninstalled"));
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ["staff", "plugins"] });
    },
    onError: () => setMessage(t("staff.plugins.uninstallFailed")),
  });
  const disable = useMutation({
    mutationFn: (pluginId: string) => apiPost("/api/staff/plugins/disable", { pluginId }),
    onSuccess: () => {
      setMessage(t("staff.plugins.disabled"));
      void queryClient.invalidateQueries({ queryKey: ["staff", "plugins"] });
    },
    onError: () => setMessage(t("staff.plugins.disableFailed")),
  });

  const active = plugins.data?.plugins.find((plugin) => plugin.id === selected) ?? null;
  const healthColumns: readonly DataTableColumn<BreakerRow>[] = [
    {
      id: "hook",
      headerKey: "staff.plugins.health.hook",
      cell: (row) => row.hook,
      sortValue: (row) => row.hook,
    },
    {
      id: "failures",
      headerKey: "staff.plugins.health.failures",
      cell: (row) => String(row.failures),
      sortValue: (row) => row.failures,
    },
    {
      id: "disabledAt",
      headerKey: "staff.plugins.health.disabledAt",
      cell: (row) => row.disabledAt ?? "",
    },
  ];

  return (
    <section className="admin-page" data-page="plugins">
      <header className="admin-page__header">
        <h1>{t("staff.plugins.title")}</h1>
        <p className="bl-muted">{t("staff.plugins.intro")}</p>
      </header>
      {message === null ? null : (
        <p className="admin-note" data-toast-tone="success">
          {message}
        </p>
      )}

      <div className="admin-grid" data-plugin-list>
        {(plugins.data?.plugins ?? []).map((plugin) => (
          <article key={plugin.id} className="admin-card" data-plugin-card={plugin.id}>
            <header>
              <h2>{plugin.name}</h2>
              <p className="bl-muted">
                {plugin.version} · <span data-plugin-state>{plugin.state}</span>
              </p>
            </header>
            <p className="bl-muted">
              {t("staff.plugins.generation", { generation: plugin.generation })}
            </p>
            {Object.entries(plugin.timings).length === 0 ? null : (
              <p className="bl-muted" data-plugin-timings>
                {Object.entries(plugin.timings)
                  .map(([key, value]) => `${key}: ${String(value)} ms`)
                  .join(" · ")}
              </p>
            )}
            <ul className="admin-list" data-plugin-capabilities>
              {plugin.capabilities.map((capability) => (
                <li key={capability.capability} data-capability={capability.capability}>
                  {capabilityLabel(t, capability)}
                </li>
              ))}
            </ul>
            {plugin.servicePrincipal.warningKey === null ? null : (
              <p className="admin-warning" data-plugin-grant-warning>
                {t("staff.plugins.grant.warning", {
                  forums: plugin.servicePrincipal.elevatedForumIds.join(", "),
                })}
              </p>
            )}
            <div className="admin-actions">
              <button
                type="button"
                className="bl-button"
                data-plugin-configure={plugin.id}
                onClick={() => {
                  setSelected(plugin.id);
                  setTab("settings");
                  setValues({});
                  setMessage(null);
                }}
              >
                {t("staff.plugins.configure")}
              </button>
              <button
                type="button"
                className="bl-button bl-button--quiet"
                data-plugin-disable={plugin.id}
                disabled={!plugin.enabled || disable.isPending}
                onClick={() => disable.mutate(plugin.id)}
              >
                {t("staff.plugins.disable")}
              </button>
              <button
                type="button"
                className="bl-button bl-button--quiet"
                data-plugin-uninstall={plugin.id}
                disabled={uninstall.isPending}
                onClick={() => uninstall.mutate(plugin.id)}
              >
                {t("staff.plugins.uninstall")}
              </button>
            </div>
          </article>
        ))}
      </div>

      {active === null ? null : (
        <section className="admin-card" data-plugin-detail={active.id}>
          <header className="admin-page__header">
            <h2>{active.name}</h2>
            <div className="admin-actions" role="tablist">
              {(["settings", "health", "errors"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  className="bl-button bl-button--quiet"
                  data-plugin-tab={value}
                  onClick={() => setTab(value)}
                >
                  {tabLabel(t, value)}
                </button>
              ))}
            </div>
          </header>

          {tab === "settings" ? (
            settings.data === undefined ? (
              <p className="bl-muted">{t("staff.plugins.loading")}</p>
            ) : (
              <FormRenderer
                definition={settings.data.definition}
                values={values}
                onChange={setValues}
                onSubmit={(next) => save.mutate(next)}
                submitting={save.isPending}
              />
            )
          ) : null}

          {tab === "health" ? (
            <div data-plugin-page="table">
              <DataTable<BreakerRow>
                rows={active.breaker}
                columns={healthColumns}
                getRowId={(row) => row.hook}
                emptyKey="staff.plugins.health.empty"
              />
            </div>
          ) : null}

          {tab === "errors" ? (
            <ol className="admin-list" data-plugin-page="log">
              {active.errors.length === 0 ? (
                <li className="bl-muted">{t("staff.plugins.errors.empty")}</li>
              ) : (
                active.errors.map((error) => (
                  <li key={`${error.createdAt}-${error.step}`} data-plugin-error>
                    <strong>{error.step}</strong> · {error.error ?? error.state} · {error.createdAt}
                  </li>
                ))
              )}
            </ol>
          ) : null}
        </section>
      )}
    </section>
  );
}
