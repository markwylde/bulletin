import { formatDate, formatNumber } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiGet } from "../api.ts";
import { Badge, DescriptionList, EmptyState, Page, Panel, QueryState } from "../ui/index.ts";

interface ServiceHealth {
  readonly name: string;
  readonly ready: boolean;
  readonly reachable: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
}

interface QueueHealth {
  readonly queue: string;
  readonly depth: number;
  readonly lagSeconds: number;
  readonly active: number;
  readonly deadLetters: number;
  readonly lagging: boolean;
}

interface VariantHealth {
  readonly route: string;
  readonly variants: number;
  readonly overBudget: boolean;
}

interface PoolHealth {
  readonly service: string;
  readonly inUse: number;
  readonly open: number;
  readonly max: number;
  readonly saturation: number;
}

interface PluginHealth {
  readonly pluginId: string;
  readonly state: string;
  readonly enabled: boolean;
  readonly failingHooks: number;
  readonly breakerTripped: boolean;
  readonly healthy: boolean;
}

export interface SystemHealthReport {
  readonly generatedAt: string;
  readonly status: "ok" | "degraded";
  readonly services: readonly ServiceHealth[];
  readonly queues: readonly QueueHealth[];
  readonly queueLagWarningSeconds: number;
  readonly deadLetters: number;
  readonly outbox: { readonly unpublished: number; readonly lagSeconds: number };
  readonly cache: {
    readonly hits: number;
    readonly misses: number;
    readonly bypasses: number;
    readonly hitRate: number | null;
    readonly bypassSeconds: number;
    readonly untrustedSeconds: number;
  };
  readonly variantBudget: number;
  readonly variants: readonly VariantHealth[];
  readonly pools: readonly PoolHealth[];
  readonly plugins: readonly PluginHealth[];
  readonly sseConnections: number;
}

/** Pool use above this share of the configured size is flagged. */
const POOL_WARNING = 0.8;
const REFRESH_MS = 15_000;

export function SystemHealthPage() {
  const t = useT();
  const locale = useLocale();
  const query = useQuery({
    queryKey: ["staff", "system", "health"],
    queryFn: () => apiGet<SystemHealthReport>("/api/staff/system/health"),
    refetchInterval: REFRESH_MS,
  });
  const number = (value: number, options: Intl.NumberFormatOptions = {}) =>
    formatNumber(value, locale, options);
  const seconds = (value: number) =>
    t("staff.systemHealth.seconds", { value: number(value, { maximumFractionDigits: 1 }) });
  const percent = (value: number) => number(value, { style: "percent", maximumFractionDigits: 1 });

  const stat = (id: string, label: string, value: ReactNode) => ({ id, label, value });

  return (
    <Page
      id="system-health"
      title={t("staff.systemHealth.title")}
      description={t("staff.systemHealth.intro")}
      meta={
        query.data === undefined ? undefined : (
          <span className="cluster">
            <Badge
              tone={query.data.status === "ok" ? "success" : "danger"}
              dot
              data-health-status={query.data.status}
            >
              {query.data.status === "ok"
                ? t("staff.systemHealth.ok")
                : t("staff.systemHealth.degraded")}
            </Badge>
            <span className="subtle">
              {t("staff.systemHealth.updated", {
                time: formatDate(new Date(query.data.generatedAt), locale, {
                  timeStyle: "medium",
                }),
              })}
            </span>
          </span>
        )
      }
    >
      <QueryState query={query} errorLabel={t("staff.systemHealth.loadError")}>
        {(data) => (
          <div className="card-grid card-grid-wide">
            <Panel flush title={t("staff.systemHealth.services")} data-health-section="services">
              <ul className="list">
                {data.services.map((service) => (
                  <li
                    key={service.name}
                    className="list-row"
                    data-health-service={service.name}
                    data-health-ok={service.ready}
                  >
                    <span className="list-row-main mono">{service.name}</span>
                    <Badge tone={service.ready ? "success" : "danger"} dot>
                      {service.ready
                        ? t("staff.systemHealth.ready")
                        : service.reachable
                          ? t("staff.systemHealth.notReady")
                          : t("staff.systemHealth.unreachable")}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel
              flush
              title={t("staff.systemHealth.queues")}
              description={t("staff.systemHealth.queuesHint", {
                seconds: data.queueLagWarningSeconds,
              })}
              data-health-section="queues"
            >
              <div className="panel-pad">
                <DescriptionList
                  items={[
                    stat(
                      "dead",
                      t("staff.systemHealth.deadLetters"),
                      <span data-health-dead-letters={data.deadLetters}>
                        {number(data.deadLetters)}
                      </span>,
                    ),
                    stat(
                      "outbox",
                      t("staff.systemHealth.outboxLag"),
                      seconds(data.outbox.lagSeconds),
                    ),
                  ]}
                />
              </div>
              {data.queues.length === 0 ? (
                <EmptyState title={t("staff.systemHealth.noQueues")} />
              ) : (
                <ul className="list">
                  {data.queues.map((queue) => (
                    <li
                      key={queue.queue}
                      className={queue.lagging ? "list-row is-warning" : "list-row"}
                      data-queue={queue.queue}
                      data-queue-lagging={queue.lagging}
                    >
                      <div className="list-row-main">
                        <span className="list-row-title mono">{queue.queue}</span>
                        <span className="list-row-meta">
                          {t("staff.systemHealth.depth")} {number(queue.depth)} ·{" "}
                          {t("staff.systemHealth.lag")} {seconds(queue.lagSeconds)} ·{" "}
                          {t("staff.systemHealth.deadLetters")} {number(queue.deadLetters)}
                        </span>
                      </div>
                      {queue.lagging ? (
                        <Badge tone="warning" role="status">
                          {t("staff.systemHealth.lagging")}
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel flush title={t("staff.systemHealth.cache")} data-health-section="cache">
              <div className="panel-pad stack">
                <DescriptionList
                  items={[
                    stat(
                      "hit",
                      t("staff.systemHealth.hitRate"),
                      <span data-health-hit-rate>
                        {data.cache.hitRate === null
                          ? t("staff.systemHealth.noData")
                          : percent(data.cache.hitRate)}
                      </span>,
                    ),
                    stat(
                      "bypass",
                      t("staff.systemHealth.bypassTime"),
                      seconds(data.cache.bypassSeconds),
                    ),
                    stat(
                      "untrusted",
                      t("staff.systemHealth.untrustedTime"),
                      seconds(data.cache.untrustedSeconds),
                    ),
                    stat("sse", t("staff.systemHealth.sse"), number(data.sseConnections)),
                  ]}
                />
                <div className="stack stack-xs">
                  <h3 className="subhead">{t("staff.systemHealth.variants")}</h3>
                  <p className="subtle">
                    {t("staff.systemHealth.variantsHint", { budget: data.variantBudget })}
                  </p>
                </div>
              </div>
              {data.variants.length === 0 ? (
                <EmptyState title={t("staff.systemHealth.noData")} />
              ) : (
                <ul className="list">
                  {data.variants.slice(0, 20).map((variant) => (
                    <li
                      key={variant.route}
                      className={variant.overBudget ? "list-row is-warning" : "list-row"}
                      data-variant-route={variant.route}
                      data-variant-over-budget={variant.overBudget}
                    >
                      <span className="list-row-main mono truncate">{variant.route}</span>
                      <span>{number(variant.variants)}</span>
                      {variant.overBudget ? (
                        <Badge tone="warning">{t("staff.systemHealth.overBudget")}</Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel flush title={t("staff.systemHealth.pools")} data-health-section="pools">
              {data.pools.length === 0 ? (
                <EmptyState title={t("staff.systemHealth.noData")} />
              ) : (
                <ul className="list">
                  {data.pools.map((pool) => (
                    <li
                      key={pool.service}
                      className={
                        pool.saturation >= POOL_WARNING ? "list-row is-warning" : "list-row"
                      }
                      data-pool={pool.service}
                    >
                      <div className="list-row-main">
                        <span className="list-row-title mono">{pool.service}</span>
                        <span className="list-row-meta">
                          {t("staff.systemHealth.poolUse", {
                            inUse: pool.inUse,
                            max: pool.max,
                            percent: percent(pool.saturation),
                          })}
                        </span>
                      </div>
                      <Meter value={pool.saturation} warn={pool.saturation >= POOL_WARNING} />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel flush title={t("staff.systemHealth.plugins")} data-health-section="plugins">
              {data.plugins.length === 0 ? (
                <EmptyState title={t("staff.systemHealth.noPlugins")} />
              ) : (
                <ul className="list">
                  {data.plugins.map((plugin) => (
                    <li
                      key={plugin.pluginId}
                      className="list-row"
                      data-health-plugin={plugin.pluginId}
                      data-health-ok={plugin.healthy}
                    >
                      <span className="list-row-main mono">{plugin.pluginId}</span>
                      <Badge
                        tone={
                          !plugin.enabled && !plugin.breakerTripped
                            ? "neutral"
                            : plugin.healthy
                              ? "success"
                              : "danger"
                        }
                        dot
                      >
                        {plugin.breakerTripped
                          ? t("staff.systemHealth.breakerTripped")
                          : !plugin.enabled
                            ? t("staff.systemHealth.pluginDisabled")
                            : plugin.healthy
                              ? t("staff.systemHealth.pluginHealthy")
                              : t("staff.systemHealth.pluginFailing", {
                                  count: plugin.failingHooks,
                                })}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        )}
      </QueryState>
    </Page>
  );
}

/** A decorative bar; the text beside it carries the value. */
function Meter({ value, warn }: { readonly value: number; readonly warn: boolean }) {
  return (
    <span className={warn ? "meter meter-warn" : "meter"} aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.round(value * 100))}%` }} />
    </span>
  );
}
