import { DEFAULT_VARIANT_BUDGET } from "@bulletin/cache";
import {
  metrics as localMetrics,
  METRIC_FAMILIES,
  type MetricSample,
  parsePrometheusText,
} from "@bulletin/config/metrics";
import type { HealthCheck } from "@bulletin/config/server";
import { QUEUE_LAG_WARNING_SECONDS, readOutboxStats, readQueueStats } from "@bulletin/db/events";
import type { SQL } from "bun";

/**
 * The staff system health panel (ADR 0020): readiness of every service over the internal
 * network, pg-boss queue lag and dead letters, outbox lag, and each process's metrics snapshot
 * (cache hit rate, bypass and untrusted time, variant cardinality, pool saturation, plugin
 * breaker trips). Locally there is no metrics stack, so this reads the services directly.
 */

export interface HealthTarget {
  readonly name: string;
  /** Base URL of the service on the internal network (its `/health/ready` is read). */
  readonly url: string;
  /** Its internal `/metrics` URL, when it exposes one. */
  readonly metricsUrl: string | null;
}

export type HealthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SystemHealthOptions {
  readonly sql: SQL;
  /** This process's own readiness checks (staff-api reports itself without a network hop). */
  readonly checks: readonly HealthCheck[];
  readonly targets: readonly HealthTarget[];
  readonly fetch?: HealthFetch;
  readonly timeoutMs?: number;
  readonly variantBudget?: number;
}

export interface ServiceHealth {
  readonly name: string;
  readonly ready: boolean;
  readonly reachable: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
}

export interface QueueHealth {
  readonly queue: string;
  readonly depth: number;
  readonly lagSeconds: number;
  readonly active: number;
  readonly deadLetters: number;
  /** Lag above {@link QUEUE_LAG_WARNING_SECONDS}: the panel highlights the queue. */
  readonly lagging: boolean;
}

export interface VariantHealth {
  readonly route: string;
  readonly variants: number;
  readonly overBudget: boolean;
}

export interface PoolHealth {
  readonly service: string;
  readonly inUse: number;
  readonly open: number;
  readonly max: number;
  /** In-use connections over the configured pool size (0–1+). */
  readonly saturation: number;
}

export interface PluginHealth {
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
    /** Hits over hits plus misses and bypasses; null before the first lookup. */
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

const DEFAULT_METRICS_PATH = "/metrics";

/**
 * Parses `BULLETIN_HEALTH_TARGETS`: comma-separated `name=url` pairs, with an optional
 * `|metricsUrl` (`user-api=http://user-api:3001|http://user-api:9464/metrics`). Without one,
 * the metrics URL is the service host on `BULLETIN_METRICS_PORT` (9464).
 */
export function healthTargetsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): HealthTarget[] {
  const metricsPort = env.BULLETIN_METRICS_PORT?.trim() || "9464";
  const targets: HealthTarget[] = [];

  for (const entry of (env.BULLETIN_HEALTH_TARGETS ?? "").split(",")) {
    const separator = entry.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const name = entry.slice(0, separator).trim();
    const [rawUrl = "", rawMetrics] = entry.slice(separator + 1).split("|");

    try {
      const url = new URL(rawUrl.trim());
      const metricsUrl =
        rawMetrics !== undefined
          ? rawMetrics.trim() === "" || rawMetrics.trim() === "off"
            ? null
            : new URL(rawMetrics.trim()).toString()
          : metricsPort === "off"
            ? null
            : `${url.protocol}//${url.hostname}:${metricsPort}${DEFAULT_METRICS_PATH}`;

      targets.push({ name, url: url.toString().replace(/\/$/, ""), metricsUrl });
    } catch {
      // An invalid entry is skipped rather than failing the whole panel.
    }
  }

  return targets;
}

async function runLocalChecks(checks: readonly HealthCheck[]): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};

  for (const check of checks) {
    try {
      results[check.name] = await check.check();
    } catch {
      results[check.name] = false;
    }
  }

  return results;
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, entry === true]),
  );
}

async function readiness(
  target: HealthTarget,
  request: HealthFetch,
  timeoutMs: number,
): Promise<ServiceHealth> {
  try {
    const response = await request(`${target.url}/health/ready`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as { checks?: unknown };

    return {
      name: target.name,
      ready: response.ok,
      reachable: true,
      checks: booleanRecord(body.checks),
    };
  } catch {
    return { name: target.name, ready: false, reachable: false, checks: {} };
  }
}

async function scrape(
  target: HealthTarget,
  request: HealthFetch,
  timeoutMs: number,
): Promise<MetricSample[]> {
  if (target.metricsUrl === null) {
    return [];
  }

  try {
    const response = await request(target.metricsUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? parsePrometheusText(await response.text()) : [];
  } catch {
    return [];
  }
}

function sum(samples: readonly MetricSample[], name: string, labels: Record<string, string> = {}) {
  return samples
    .filter(
      (sample) =>
        sample.name === name &&
        Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
    )
    .reduce((total, sample) => total + sample.value, 0);
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function pluginHealth(sql: SQL): Promise<PluginHealth[]> {
  const rows = (await sql`
    SELECT
      p.plugin_id,
      p.state,
      p.enabled,
      count(b.hook) FILTER (WHERE b.failures > 0)::int AS failing_hooks,
      bool_or(b.disabled_at IS NOT NULL) AS tripped
    FROM core.plugins p
    LEFT JOIN core.plugin_breaker b ON b.plugin_id = p.plugin_id
    GROUP BY p.plugin_id, p.state, p.enabled
    ORDER BY p.plugin_id
  `) as Array<{
    plugin_id: string;
    state: string;
    enabled: boolean;
    failing_hooks: number;
    tripped: boolean | null;
  }>;

  return rows.map((row) => {
    const breakerTripped = row.tripped === true;

    return {
      pluginId: row.plugin_id,
      state: row.state,
      enabled: row.enabled,
      failingHooks: row.failing_hooks,
      breakerTripped,
      healthy: !breakerTripped && row.failing_hooks === 0 && row.state !== "failed",
    };
  });
}

export async function readSystemHealth(options: SystemHealthOptions): Promise<SystemHealthReport> {
  const request = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 2_000;
  const budget = options.variantBudget ?? DEFAULT_VARIANT_BUDGET;

  const [ownChecks, remote, scrapes, ownMetrics, queues, outbox, plugins] = await Promise.all([
    runLocalChecks(options.checks),
    Promise.all(options.targets.map((target) => readiness(target, request, timeoutMs))),
    Promise.all(
      options.targets.map(async (target) => ({
        service: target.name,
        samples: await scrape(target, request, timeoutMs),
      })),
    ),
    localMetrics.expose().then(parsePrometheusText),
    readQueueStats(options.sql),
    readOutboxStats(options.sql),
    pluginHealth(options.sql),
  ]);

  const services: ServiceHealth[] = [
    {
      name: "staff-api",
      ready: Object.values(ownChecks).every(Boolean),
      reachable: true,
      checks: ownChecks,
    },
    ...remote.filter((service) => service.name !== "staff-api"),
  ];
  const snapshots = [
    { service: "staff-api", samples: ownMetrics },
    ...scrapes.filter((entry) => entry.service !== "staff-api"),
  ];
  const all = snapshots.flatMap((entry) => entry.samples);

  const hits = sum(all, METRIC_FAMILIES.cacheRequests, { result: "hit" });
  const misses = sum(all, METRIC_FAMILIES.cacheRequests, { result: "miss" });
  const bypasses = sum(all, METRIC_FAMILIES.cacheRequests, { result: "bypass" });
  const lookups = hits + misses + bypasses;

  const variantsByRoute = new Map<string, number>();

  for (const sample of all) {
    if (sample.name === METRIC_FAMILIES.cacheVariants && sample.labels.route !== undefined) {
      variantsByRoute.set(
        sample.labels.route,
        Math.max(variantsByRoute.get(sample.labels.route) ?? 0, sample.value),
      );
    }
  }

  const pools = snapshots
    .filter((entry) => entry.samples.some((sample) => sample.name === METRIC_FAMILIES.dbPoolMax))
    .map((entry) => {
      const max = sum(entry.samples, METRIC_FAMILIES.dbPoolMax);
      const inUse =
        sum(entry.samples, METRIC_FAMILIES.dbPoolConnections, { state: "active" }) +
        sum(entry.samples, METRIC_FAMILIES.dbPoolConnections, { state: "idle in transaction" });
      const open = sum(entry.samples, METRIC_FAMILIES.dbPoolConnections);

      return {
        service: entry.service,
        inUse,
        open,
        max,
        saturation: max > 0 ? round(inUse / max) : 0,
      };
    });

  const queueHealth = queues.map((stat) => ({
    queue: stat.queue,
    depth: stat.depth,
    lagSeconds: round(stat.lagSeconds, 1),
    active: stat.active,
    deadLetters: stat.deadLetters,
    lagging: stat.lagSeconds > QUEUE_LAG_WARNING_SECONDS,
  }));
  const variants = [...variantsByRoute]
    .map(([route, count]) => ({ route, variants: count, overBudget: count > budget }))
    .sort((left, right) => right.variants - left.variants || left.route.localeCompare(right.route));
  const degraded =
    services.some((service) => !service.ready) ||
    queueHealth.some((queue) => queue.lagging) ||
    variants.some((variant) => variant.overBudget) ||
    plugins.some((plugin) => plugin.enabled && !plugin.healthy);

  return {
    generatedAt: new Date().toISOString(),
    status: degraded ? "degraded" : "ok",
    services,
    queues: queueHealth,
    queueLagWarningSeconds: QUEUE_LAG_WARNING_SECONDS,
    deadLetters: queues.reduce((total, stat) => total + stat.deadLetters, 0),
    outbox: { unpublished: outbox.unpublished, lagSeconds: round(outbox.lagSeconds, 1) },
    cache: {
      hits,
      misses,
      bypasses,
      hitRate: lookups === 0 ? null : round(hits / lookups),
      bypassSeconds: round(sum(all, METRIC_FAMILIES.cacheBypassSeconds)),
      untrustedSeconds: round(sum(all, METRIC_FAMILIES.cacheUntrustedSeconds)),
    },
    variantBudget: budget,
    variants,
    pools,
    plugins,
    sseConnections: sum(all, METRIC_FAMILIES.sseConnections),
  };
}
