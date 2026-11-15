import { beginStepUp } from "@bulletin/domain/auth/browser";
import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { type FormDefinition, FormRenderer, type FormValues } from "@bulletin/ui/forms";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconTrash,
  MenuItem,
  Notice,
  Page,
  Panel,
  QueryState,
  RowActions,
  Skeleton,
  type Tone,
} from "../ui/index.ts";

function pluginStateLabel(t: ReturnType<typeof useT>, state: string): string {
  switch (state) {
    case "installing":
      return t("staff.plugins.state.installing");
    case "active":
      return t("staff.plugins.state.active");
    case "disabled":
      return t("staff.plugins.state.disabled");
    case "upgrading":
      return t("staff.plugins.state.upgrading");
    case "failed":
      return t("staff.plugins.state.failed");
    case "uninstalled":
      return t("staff.plugins.state.uninstalled");
    default:
      return state;
  }
}

function timingLabel(t: ReturnType<typeof useT>, key: string, ms: number): string {
  return key === "activationMs"
    ? t("staff.plugins.timing.activation", { ms })
    : t("staff.plugins.timing.other", { ms });
}

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
    case "db":
      return t("staff.plugins.capability.db");
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
    default:
      return tab.slice("page:".length);
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

interface DeclaredPage {
  readonly id: string;
  readonly kind: string;
  readonly titleKey: string;
  readonly definition: Readonly<Record<string, unknown>>;
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
  readonly declaredPages: readonly DeclaredPage[];
}

interface PluginSettings {
  readonly definition: FormDefinition;
  readonly values: FormValues;
}

type PluginTab = "settings" | "health" | "errors" | `page:${string}`;

interface MarketplacePackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly installable: boolean;
}

interface PluginReview {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly egressHosts: readonly string[];
  readonly review: readonly Capability[];
}

/** Plugins with no row, or an uninstalled or failed one, can be installed from the catalog. */
const REINSTALLABLE = new Set(["uninstalled", "failed"]);
const BUSY_STATES = new Set(["installing", "upgrading"]);

function DeclaredPluginPageView({ page }: { readonly page: DeclaredPage }) {
  const definition = page.definition;
  const columns = Array.isArray(definition.columns)
    ? definition.columns.filter(
        (column): column is { id: string; labelKey: string } =>
          typeof column === "object" &&
          column !== null &&
          typeof (column as { id?: unknown }).id === "string" &&
          typeof (column as { labelKey?: unknown }).labelKey === "string",
      )
    : [];
  const rows = Array.isArray(definition.rows)
    ? definition.rows.filter(
        (row): row is Record<string, string> => typeof row === "object" && row !== null,
      )
    : [];

  if (page.kind === "table") {
    return (
      <div data-plugin-declared-page={page.id} data-plugin-page-type="table">
        <DataTable<Record<string, string>>
          rows={rows}
          columns={columns.map((column) => ({
            id: column.id,
            headerKey: column.labelKey,
            cell: (row) => row[column.id] ?? "",
          }))}
          getRowId={(row) => columns.map((column) => row[column.id] ?? "").join(":")}
          emptyKey="staff.plugins.page.empty"
        />
      </div>
    );
  }

  return (
    <div data-plugin-declared-page={page.id} data-plugin-page-type={page.kind}>
      <ul className="list">
        {rows.map((row) => {
          const text = Object.values(row).join(" · ");
          return (
            <li key={text} className="list-row">
              {text}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PluginsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<PluginTab>("settings");
  const [values, setValues] = useState<FormValues>({});
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const toast = useToast();

  const plugins = useQuery({
    queryKey: ["staff", "plugins"],
    queryFn: () => apiGet<{ plugins: readonly StaffPlugin[] }>("/api/staff/plugins"),
    // plugin-host moves an installing plugin to active or failed; follow it until it settles.
    refetchInterval: (query) =>
      query.state.data?.plugins.some((plugin) => BUSY_STATES.has(plugin.state)) === true
        ? 1_500
        : false,
  });
  const catalog = useQuery({
    queryKey: ["staff", "plugins", "catalog"],
    queryFn: () =>
      apiGet<{ packages: readonly MarketplacePackage[] }>("/api/staff/plugins/catalog"),
  });
  const review = useQuery({
    // Outside the ["staff", "plugins"] prefix: an install must not refetch its own review.
    queryKey: ["staff", "plugin-review", reviewing],
    queryFn: () =>
      apiGet<{ plugin: PluginReview }>(
        `/api/staff/plugins/review?pluginId=${encodeURIComponent(reviewing ?? "")}`,
      ),
    enabled: reviewing !== null,
    retry: false,
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
      toast.pushToast({ messageKey: "staff.plugins.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "plugins"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.plugins.saveFailed", tone: "error" }),
  });
  const uninstall = useMutation({
    mutationFn: (pluginId: string) =>
      apiPost("/api/staff/plugins/uninstall", { pluginId, dataAction: "keep" }),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.plugins.uninstalled", tone: "success" });
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ["staff", "plugins"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.plugins.uninstallFailed", tone: "error" }),
  });
  const install = useMutation({
    mutationFn: (plugin: PluginReview) =>
      apiPost("/api/staff/plugins/install", {
        pluginId: plugin.id,
        approved: true,
        capabilities: plugin.capabilities,
        egressHosts: plugin.egressHosts,
      }),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.plugins.installing", tone: "success" });
      setReviewing(null);
      void queryClient.invalidateQueries({ queryKey: ["staff", "plugins"] });
    },
    onError: (error) => {
      // Installing grants access to the board, so it needs a fresh sign-in (ADR 0009).
      if (error instanceof ApiError && error.code === "step_up_required") {
        void beginStepUp({ returnTo: "/plugins" });
        return;
      }

      toast.pushToast({ messageKey: "staff.plugins.installFailed", tone: "error" });
    },
  });
  const enable = useMutation({
    mutationFn: (pluginId: string) => apiPost("/api/staff/plugins/enable", { pluginId }),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.plugins.enabling", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "plugins"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.plugins.enableFailed", tone: "error" }),
  });
  const disable = useMutation({
    mutationFn: (pluginId: string) => apiPost("/api/staff/plugins/disable", { pluginId }),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.plugins.disabled", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "plugins"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.plugins.disableFailed", tone: "error" }),
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

  const stateTone = (plugin: StaffPlugin): Tone =>
    plugin.state === "active" ? "success" : plugin.enabled ? "warning" : "neutral";
  const tabs: readonly PluginTab[] =
    active === null
      ? []
      : [
          "settings",
          "health",
          "errors",
          ...active.declaredPages.map((page) => `page:${page.id}` as const),
        ];
  const confirmPlugin = plugins.data?.plugins.find((plugin) => plugin.id === confirmUninstall);
  const installed = new Map((plugins.data?.plugins ?? []).map((plugin) => [plugin.id, plugin]));
  const available = (catalog.data?.packages ?? []).filter((entry) => {
    const plugin = installed.get(entry.id);
    return plugin === undefined || REINSTALLABLE.has(plugin.state);
  });
  const closeReview = () => setReviewing(null);

  return (
    <Page id="plugins" title={t("staff.plugins.title")} description={t("staff.plugins.intro")}>
      <QueryState query={plugins} errorLabel={t("staff.plugins.loadError")}>
        {(data) =>
          data.plugins.length === 0 ? (
            <Panel>
              <EmptyState title={t("staff.plugins.empty")} />
            </Panel>
          ) : (
            <div className="card-grid" data-plugin-list>
              {data.plugins.map((plugin) => (
                <Panel
                  key={plugin.id}
                  title={plugin.name}
                  className={plugin.id === selected ? "is-selected" : undefined}
                  data-plugin-card={plugin.id}
                  actions={
                    <span className="cluster cluster-end">
                      <Button
                        size="sm"
                        data-plugin-configure={plugin.id}
                        onClick={() => {
                          setSelected(plugin.id);
                          setTab("settings");
                          setValues({});
                        }}
                      >
                        {t("staff.plugins.configure")}
                      </Button>
                      <RowActions label={t("staff.rowActions")}>
                        <MenuItem
                          data-plugin-enable={plugin.id}
                          disabled={
                            (plugin.state !== "disabled" && plugin.state !== "failed") ||
                            enable.isPending
                          }
                          onClick={() => enable.mutate(plugin.id)}
                        >
                          {t("staff.plugins.enable")}
                        </MenuItem>
                        <MenuItem
                          data-plugin-disable={plugin.id}
                          disabled={!plugin.enabled || disable.isPending}
                          onClick={() => disable.mutate(plugin.id)}
                        >
                          {t("staff.plugins.disable")}
                        </MenuItem>
                        <MenuItem
                          tone="danger"
                          icon={<IconTrash size={16} />}
                          data-plugin-uninstall={plugin.id}
                          disabled={uninstall.isPending}
                          onClick={() => setConfirmUninstall(plugin.id)}
                        >
                          {t("staff.plugins.uninstall")}
                        </MenuItem>
                      </RowActions>
                    </span>
                  }
                >
                  <div className="stack stack-sm">
                    <span className="cluster">
                      <Badge tone={stateTone(plugin)} dot>
                        <span data-plugin-state={plugin.state}>
                          {pluginStateLabel(t, plugin.state)}
                        </span>
                      </Badge>
                      <span className="subtle mono">{plugin.version}</span>
                      <span className="subtle">
                        {t("staff.plugins.generation", { generation: plugin.generation })}
                      </span>
                    </span>
                    {Object.entries(plugin.timings).length === 0 ? null : (
                      <p className="subtle" data-plugin-timings>
                        {Object.entries(plugin.timings).map(([key, value], index) => (
                          <span key={key} data-plugin-timing={key}>
                            {index === 0 ? null : " · "}
                            {timingLabel(t, key, value)}
                          </span>
                        ))}
                      </p>
                    )}
                    <ul className="plain-list" data-plugin-capabilities>
                      {plugin.capabilities.map((capability) => (
                        <li key={capability.capability} data-capability={capability.capability}>
                          {capabilityLabel(t, capability)}
                        </li>
                      ))}
                    </ul>
                    {plugin.servicePrincipal.warningKey === null ? null : (
                      <Notice
                        tone="warning"
                        data-plugin-grant-warning
                        title={t("staff.plugins.grant.warning", {
                          forums: plugin.servicePrincipal.elevatedForumIds.join(", "),
                        })}
                      />
                    )}
                  </div>
                </Panel>
              ))}
            </div>
          )
        }
      </QueryState>

      <Panel
        title={t("staff.plugins.marketplace.title")}
        description={t("staff.plugins.marketplace.intro")}
        data-plugin-marketplace
      >
        <QueryState query={catalog} errorLabel={t("staff.plugins.marketplace.loadError")}>
          {() =>
            available.length === 0 ? (
              <EmptyState title={t("staff.plugins.marketplace.empty")} />
            ) : (
              <ul className="list">
                {available.map((entry) => (
                  <li key={entry.id} className="list-row" data-marketplace-package={entry.id}>
                    <div className="list-row-main">
                      <span className="list-row-title">{entry.name}</span>
                      <span className="list-row-meta">
                        <span className="mono">{entry.version}</span> · {entry.author}
                      </span>
                      <span className="subtle">{entry.description}</span>
                    </div>
                    <Button
                      size="sm"
                      data-plugin-review={entry.id}
                      disabled={!entry.installable}
                      onClick={() => setReviewing(entry.id)}
                    >
                      {t("staff.plugins.review")}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryState>
      </Panel>

      <Dialog
        open={reviewing !== null}
        title={t("staff.plugins.review.title", {
          name: review.data?.plugin.name ?? reviewing ?? "",
        })}
        closeLabel={t("staff.nav.close")}
        onClose={closeReview}
        footer={
          <>
            <Button variant="ghost" onClick={closeReview}>
              {t("staff.plugins.cancel")}
            </Button>
            <Button
              variant="primary"
              data-plugin-install={reviewing ?? ""}
              disabled={review.data === undefined || install.isPending}
              onClick={() => {
                if (review.data !== undefined) {
                  install.mutate(review.data.plugin);
                }
              }}
            >
              {t("staff.plugins.install")}
            </Button>
          </>
        }
      >
        <QueryState query={review} errorLabel={t("staff.plugins.review.loadError")}>
          {(data) => (
            <div className="stack stack-sm" data-plugin-review-capabilities={data.plugin.id}>
              <p>{t("staff.plugins.review.body")}</p>
              <ul className="plain-list">
                {data.plugin.review.map((capability) => (
                  <li key={capability.capability} data-capability={capability.capability}>
                    {capabilityLabel(t, capability)}
                    {capability.capability.startsWith("egress:")
                      ? ` (${capability.capability.slice("egress:".length)})`
                      : null}
                    {capability.elevated ? (
                      <>
                        {" "}
                        <Badge tone="warning">{t("staff.plugins.review.elevated")}</Badge>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </QueryState>
      </Dialog>

      {active === null ? null : (
        <Panel title={active.name} data-plugin-detail={active.id}>
          <div className="tabs" role="tablist" aria-label={active.name}>
            {tabs.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                className="tab"
                aria-selected={tab === value}
                data-plugin-tab={value}
                onClick={() => setTab(value)}
              >
                {value.startsWith("page:")
                  ? (() => {
                      const titleKey = active.declaredPages.find(
                        (page) => `page:${page.id}` === value,
                      )?.titleKey;
                      return titleKey === undefined || titleKey === ""
                        ? t("staff.plugins.page.declared")
                        : t(titleKey);
                    })()
                  : tabLabel(t, value)}
              </button>
            ))}
          </div>

          <div className="tab-panel">
            {tab === "settings" ? (
              settings.data === undefined ? (
                <Skeleton lines={3} label={t("staff.plugins.loading")} />
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

            {tab.startsWith("page:") ? (
              <DeclaredPluginPageView
                page={
                  active.declaredPages.find((page) => `page:${page.id}` === tab) as DeclaredPage
                }
              />
            ) : null}

            {tab === "errors" ? (
              <ol className="list" data-plugin-page="log">
                {active.errors.length === 0 ? (
                  <li className="list-row subtle">{t("staff.plugins.errors.empty")}</li>
                ) : (
                  active.errors.map((error) => (
                    <li
                      key={`${error.createdAt}-${error.step}`}
                      className="list-row"
                      data-plugin-error
                    >
                      <div className="list-row-main">
                        <span className="list-row-title mono">{error.step}</span>
                        <span className="list-row-meta">
                          {error.error ?? error.state} · {error.createdAt}
                        </span>
                      </div>
                    </li>
                  ))
                )}
              </ol>
            ) : null}
          </div>
        </Panel>
      )}

      <ConfirmDialog
        open={confirmPlugin !== undefined}
        titleKey="staff.plugins.confirmUninstall.title"
        bodyKey="staff.plugins.confirmUninstall.body"
        confirmLabelKey="staff.plugins.uninstall"
        tone="danger"
        busy={uninstall.isPending}
        onCancel={() => setConfirmUninstall(null)}
        onConfirm={() => {
          const id = confirmUninstall;
          setConfirmUninstall(null);

          if (id !== null) {
            uninstall.mutate(id);
          }
        }}
      />
    </Page>
  );
}
