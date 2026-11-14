import { formatDate, formatNumber } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api.ts";

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

  return (
    <div className="page" data-page="system-health">
      <header className="page-header">
        <h1>{t("staff.systemHealth.title")}</h1>
        <p>{t("staff.systemHealth.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.systemHealth.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}
      {query.isSuccess ? (
        <>
          <p
            className={`health-status health-status-${query.data.status}`}
            data-health-status={query.data.status}
          >
            {query.data.status === "ok"
              ? t("staff.systemHealth.ok")
              : t("staff.systemHealth.degraded")}{" "}
            <span className="widget-muted">
              {t("staff.systemHealth.updated", {
                time: formatDate(new Date(query.data.generatedAt), locale, {
                  timeStyle: "medium",
                }),
              })}
            </span>
          </p>
          <div className="widget-grid system-grid">
            <section className="widget" data-health-section="services">
              <h2>{t("staff.systemHealth.services")}</h2>
              <ul className="health-list">
                {query.data.services.map((service) => (
                  <li
                    key={service.name}
                    data-health-service={service.name}
                    data-health-ok={service.ready}
                  >
                    <span className="system-name">{service.name}</span>
                    <span className={service.ready ? "system-ok" : "system-bad"}>
                      {service.ready
                        ? t("staff.systemHealth.ready")
                        : service.reachable
                          ? t("staff.systemHealth.notReady")
                          : t("staff.systemHealth.unreachable")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="widget" data-health-section="queues">
              <h2>{t("staff.systemHealth.queues")}</h2>
              <p className="widget-muted">
                {t("staff.systemHealth.queuesHint", {
                  seconds: query.data.queueLagWarningSeconds,
                })}
              </p>
              {query.data.queues.length === 0 ? (
                <p className="widget-muted">{t("staff.systemHealth.noQueues")}</p>
              ) : (
                <ul className="system-list">
                  {query.data.queues.map((queue) => (
                    <li
                      key={queue.queue}
                      className={queue.lagging ? "system-row is-warning" : "system-row"}
                      data-queue={queue.queue}
                      data-queue-lagging={queue.lagging}
                    >
                      <span className="system-name">{queue.queue}</span>
                      <dl className="system-stats">
                        <div>
                          <dt>{t("staff.systemHealth.depth")}</dt>
                          <dd>{number(queue.depth)}</dd>
                        </div>
                        <div>
                          <dt>{t("staff.systemHealth.lag")}</dt>
                          <dd>{seconds(queue.lagSeconds)}</dd>
                        </div>
                        <div>
                          <dt>{t("staff.systemHealth.deadLetters")}</dt>
                          <dd>{number(queue.deadLetters)}</dd>
                        </div>
                      </dl>
                      {queue.lagging ? (
                        <span className="system-bad" role="status">
                          {t("staff.systemHealth.lagging")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <dl className="stat-grid system-summary">
                <div>
                  <dt>{t("staff.systemHealth.deadLetters")}</dt>
                  <dd data-health-dead-letters={query.data.deadLetters}>
                    {number(query.data.deadLetters)}
                  </dd>
                </div>
                <div>
                  <dt>{t("staff.systemHealth.outboxLag")}</dt>
                  <dd>{seconds(query.data.outbox.lagSeconds)}</dd>
                </div>
              </dl>
            </section>

            <section className="widget" data-health-section="cache">
              <h2>{t("staff.systemHealth.cache")}</h2>
              <dl className="stat-grid">
                <div>
                  <dt>{t("staff.systemHealth.hitRate")}</dt>
                  <dd data-health-hit-rate>
                    {query.data.cache.hitRate === null
                      ? t("staff.systemHealth.noData")
                      : percent(query.data.cache.hitRate)}
                  </dd>
                </div>
                <div>
                  <dt>{t("staff.systemHealth.bypassTime")}</dt>
                  <dd>{seconds(query.data.cache.bypassSeconds)}</dd>
                </div>
                <div>
                  <dt>{t("staff.systemHealth.untrustedTime")}</dt>
                  <dd>{seconds(query.data.cache.untrustedSeconds)}</dd>
                </div>
                <div>
                  <dt>{t("staff.systemHealth.sse")}</dt>
                  <dd>{number(query.data.sseConnections)}</dd>
                </div>
              </dl>
              <h3 className="system-subhead">{t("staff.systemHealth.variants")}</h3>
              <p className="widget-muted">
                {t("staff.systemHealth.variantsHint", { budget: query.data.variantBudget })}
              </p>
              {query.data.variants.length === 0 ? (
                <p className="widget-muted">{t("staff.systemHealth.noData")}</p>
              ) : (
                <ul className="system-list">
                  {query.data.variants.slice(0, 20).map((variant) => (
                    <li
                      key={variant.route}
                      className={variant.overBudget ? "system-row is-warning" : "system-row"}
                      data-variant-route={variant.route}
                      data-variant-over-budget={variant.overBudget}
                    >
                      <span className="system-name">{variant.route}</span>
                      <span>{number(variant.variants)}</span>
                      {variant.overBudget ? (
                        <span className="system-bad">{t("staff.systemHealth.overBudget")}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="widget" data-health-section="pools">
              <h2>{t("staff.systemHealth.pools")}</h2>
              {query.data.pools.length === 0 ? (
                <p className="widget-muted">{t("staff.systemHealth.noData")}</p>
              ) : (
                <ul className="system-list">
                  {query.data.pools.map((pool) => (
                    <li
                      key={pool.service}
                      className={
                        pool.saturation >= POOL_WARNING ? "system-row is-warning" : "system-row"
                      }
                      data-pool={pool.service}
                    >
                      <span className="system-name">{pool.service}</span>
                      <span>
                        {t("staff.systemHealth.poolUse", {
                          inUse: pool.inUse,
                          max: pool.max,
                          percent: percent(pool.saturation),
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="widget" data-health-section="plugins">
              <h2>{t("staff.systemHealth.plugins")}</h2>
              {query.data.plugins.length === 0 ? (
                <p className="widget-muted">{t("staff.systemHealth.noPlugins")}</p>
              ) : (
                <ul className="health-list">
                  {query.data.plugins.map((plugin) => (
                    <li
                      key={plugin.pluginId}
                      data-health-plugin={plugin.pluginId}
                      data-health-ok={plugin.healthy}
                    >
                      <span className="system-name">{plugin.pluginId}</span>
                      <span className={plugin.healthy ? "system-ok" : "system-bad"}>
                        {plugin.breakerTripped
                          ? t("staff.systemHealth.breakerTripped")
                          : !plugin.enabled
                            ? t("staff.systemHealth.pluginDisabled")
                            : plugin.healthy
                              ? t("staff.systemHealth.pluginHealthy")
                              : t("staff.systemHealth.pluginFailing", {
                                  count: plugin.failingHooks,
                                })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
