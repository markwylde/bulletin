/**
 * A minimal Prometheus text-exposition library (ADR 0020): counters, gauges and histograms with
 * labels, scrape-time collectors and a parser for the staff health panel and the load test.
 * Every process uses the shared {@link metrics} registry, which declares the standard families
 * up front so a scrape always lists each of them, even before the first sample.
 */

export type Labels = Readonly<Record<string, string>>;
export type MetricType = "counter" | "gauge" | "histogram";

/** Seconds; covers fast cache hits up to slow cold renders and plugin timeouts. */
export const DEFAULT_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.08, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5, 10,
];

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}\u0000${labels[name] ?? ""}`)
    .join("\u0001");
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function formatLabels(labels: Labels, extra?: Labels): string {
  const merged = { ...labels, ...extra };
  const names = Object.keys(merged).sort();

  if (names.length === 0) {
    return "";
  }

  return `{${names.map((name) => `${name}="${escapeLabel(merged[name] ?? "")}"`).join(",")}}`;
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }

  if (value === Number.POSITIVE_INFINITY) {
    return "+Inf";
  }

  if (value === Number.NEGATIVE_INFINITY) {
    return "-Inf";
  }

  return String(value);
}

interface MetricBase {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  /** Renders this family's sample lines (without HELP/TYPE). */
  samples(): string[];
  reset(): void;
}

function checkLabels(names: readonly string[], labels: Labels, metric: string): void {
  for (const name of Object.keys(labels)) {
    if (!LABEL.test(name) || !names.includes(name)) {
      throw new Error(`Metric ${metric} has no label "${name}"`);
    }
  }
}

export class Counter implements MetricBase {
  readonly type = "counter" as const;
  readonly #values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {}

  inc(labels: Labels = {}, value = 1): void {
    if (value < 0 || !Number.isFinite(value)) {
      throw new Error(`Counter ${this.name} can only increase`);
    }

    checkLabels(this.labelNames, labels, this.name);
    const key = labelKey(labels);
    const current = this.#values.get(key);

    if (current === undefined) {
      this.#values.set(key, { labels: { ...labels }, value });
    } else {
      current.value += value;
    }
  }

  value(labels: Labels = {}): number {
    return this.#values.get(labelKey(labels))?.value ?? 0;
  }

  samples(): string[] {
    if (this.#values.size === 0 && this.labelNames.length === 0) {
      return [`${this.name} 0`];
    }

    return [...this.#values.values()].map(
      (entry) => `${this.name}${formatLabels(entry.labels)} ${formatValue(entry.value)}`,
    );
  }

  reset(): void {
    this.#values.clear();
  }
}

export class Gauge implements MetricBase {
  readonly type = "gauge" as const;
  readonly #values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {}

  set(labels: Labels, value: number): void {
    checkLabels(this.labelNames, labels, this.name);
    this.#values.set(labelKey(labels), { labels: { ...labels }, value });
  }

  inc(labels: Labels = {}, value = 1): void {
    this.set(labels, this.value(labels) + value);
  }

  dec(labels: Labels = {}, value = 1): void {
    this.set(labels, this.value(labels) - value);
  }

  value(labels: Labels = {}): number {
    return this.#values.get(labelKey(labels))?.value ?? 0;
  }

  /** Replaces every labelled value; collectors use it so vanished series disappear. */
  replace(entries: ReadonlyArray<readonly [Labels, number]>): void {
    this.#values.clear();

    for (const [labels, value] of entries) {
      this.set(labels, value);
    }
  }

  samples(): string[] {
    if (this.#values.size === 0 && this.labelNames.length === 0) {
      return [`${this.name} 0`];
    }

    return [...this.#values.values()].map(
      (entry) => `${this.name}${formatLabels(entry.labels)} ${formatValue(entry.value)}`,
    );
  }

  reset(): void {
    this.#values.clear();
  }
}

interface HistogramSeries {
  readonly labels: Labels;
  readonly counts: number[];
  sum: number;
  count: number;
}

export class Histogram implements MetricBase {
  readonly type = "histogram" as const;
  readonly #series = new Map<string, HistogramSeries>();
  readonly buckets: readonly number[];

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
    buckets: readonly number[] = DEFAULT_BUCKETS,
  ) {
    this.buckets = [...buckets].sort((left, right) => left - right);
  }

  observe(labels: Labels, value: number): void {
    checkLabels(this.labelNames, labels, this.name);
    const key = labelKey(labels);
    let series = this.#series.get(key);

    if (series === undefined) {
      series = { labels: { ...labels }, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.#series.set(key, series);
    }

    for (const [index, bound] of this.buckets.entries()) {
      if (value <= bound) {
        series.counts[index] = (series.counts[index] ?? 0) + 1;
      }
    }

    series.sum += value;
    series.count += 1;
  }

  /** Starts a timer; the returned function observes the elapsed seconds. */
  startTimer(labels: Labels = {}): (extra?: Labels) => number {
    const started = performance.now();

    return (extra) => {
      const seconds = (performance.now() - started) / 1_000;
      this.observe({ ...labels, ...extra }, seconds);
      return seconds;
    };
  }

  samples(): string[] {
    const lines: string[] = [];

    for (const series of this.#series.values()) {
      for (const [index, bound] of this.buckets.entries()) {
        lines.push(
          `${this.name}_bucket${formatLabels(series.labels, { le: formatValue(bound) })} ${
            series.counts[index] ?? 0
          }`,
        );
      }

      lines.push(
        `${this.name}_bucket${formatLabels(series.labels, { le: "+Inf" })} ${series.count}`,
      );
      lines.push(`${this.name}_sum${formatLabels(series.labels)} ${formatValue(series.sum)}`);
      lines.push(`${this.name}_count${formatLabels(series.labels)} ${series.count}`);
    }

    return lines;
  }

  reset(): void {
    this.#series.clear();
  }
}

export type Collector = () => void | Promise<void>;

export class MetricsRegistry {
  readonly #metrics = new Map<string, MetricBase>();
  readonly #collectors = new Set<Collector>();
  readonly #defaultLabels: Record<string, string> = {};

  #register<T extends MetricBase>(metric: T): T {
    if (!NAME.test(metric.name)) {
      throw new Error(`Invalid metric name ${metric.name}`);
    }

    const existing = this.#metrics.get(metric.name);

    if (existing !== undefined) {
      if (existing.type !== metric.type) {
        throw new Error(`Metric ${metric.name} is already registered as a ${existing.type}`);
      }

      return existing as T;
    }

    this.#metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.#register(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.#register(new Gauge(name, help, labelNames));
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets?: readonly number[],
  ): Histogram {
    return this.#register(new Histogram(name, help, labelNames, buckets));
  }

  get(name: string): MetricBase | undefined {
    return this.#metrics.get(name);
  }

  /** Labels added to every sample, e.g. `service`. */
  setDefaultLabels(labels: Labels): void {
    Object.assign(this.#defaultLabels, labels);
  }

  /** Runs at scrape time; returns an unregister function. */
  addCollector(collector: Collector): () => void {
    this.#collectors.add(collector);
    return () => {
      this.#collectors.delete(collector);
    };
  }

  async collect(): Promise<void> {
    await Promise.all(
      [...this.#collectors].map(async (collector) => {
        try {
          await collector();
        } catch {
          // A failed collector leaves its previous values; the scrape still succeeds.
        }
      }),
    );
  }

  /** The Prometheus text exposition format (version 0.0.4). */
  async expose(): Promise<string> {
    await this.collect();
    const lines: string[] = [];
    const defaults = this.#defaultLabels;
    const hasDefaults = Object.keys(defaults).length > 0;

    for (const metric of [...this.#metrics.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      lines.push(`# HELP ${metric.name} ${metric.help.replaceAll("\n", " ")}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      for (const sample of metric.samples()) {
        lines.push(hasDefaults ? withDefaultLabels(sample, defaults) : sample);
      }
    }

    return `${lines.join("\n")}\n`;
  }

  resetValues(): void {
    for (const metric of this.#metrics.values()) {
      metric.reset();
    }
  }
}

function withDefaultLabels(sample: string, defaults: Labels): string {
  const space = sample.lastIndexOf(" ");
  const head = sample.slice(0, space);
  const value = sample.slice(space + 1);
  const brace = head.indexOf("{");
  const name = brace === -1 ? head : head.slice(0, brace);
  const existing = brace === -1 ? {} : parseLabels(head.slice(brace + 1, -1));

  return `${name}${formatLabels({ ...defaults, ...existing })} ${value}`;
}

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Standard metric families from ADR 0020; every service exposes all of them. */
export const METRIC_FAMILIES = {
  requestDuration: "bulletin_http_request_duration_seconds",
  cacheRequests: "bulletin_cache_requests_total",
  cacheBypassSeconds: "bulletin_cache_bypass_seconds_total",
  cacheUntrustedSeconds: "bulletin_cache_untrusted_seconds_total",
  cacheVariants: "bulletin_cache_variants",
  queueDepth: "bulletin_queue_depth",
  queueLag: "bulletin_queue_lag_seconds",
  deadLetters: "bulletin_dead_letters",
  outboxLag: "bulletin_outbox_publish_lag_seconds",
  sseConnections: "bulletin_sse_connections",
  pluginHookDuration: "bulletin_plugin_hook_duration_seconds",
  pluginBreakerTrips: "bulletin_plugin_breaker_trips_total",
  dbPoolConnections: "bulletin_db_pool_connections",
  dbPoolMax: "bulletin_db_pool_max",
} as const;

export interface StandardMetrics {
  readonly requestDuration: Histogram;
  readonly cacheRequests: Counter;
  readonly cacheBypassSeconds: Counter;
  readonly cacheUntrustedSeconds: Counter;
  readonly cacheVariants: Gauge;
  readonly queueDepth: Gauge;
  readonly queueLag: Gauge;
  readonly deadLetters: Gauge;
  readonly outboxLag: Gauge;
  readonly sseConnections: Gauge;
  readonly pluginHookDuration: Histogram;
  readonly pluginBreakerTrips: Counter;
  readonly dbPoolConnections: Gauge;
  readonly dbPoolMax: Gauge;
}

export function declareStandardMetrics(registry: MetricsRegistry): StandardMetrics {
  return {
    requestDuration: registry.histogram(
      METRIC_FAMILIES.requestDuration,
      "Request latency per route",
      ["route", "method", "status"],
    ),
    cacheRequests: registry.counter(
      METRIC_FAMILIES.cacheRequests,
      "Render cache lookups by result (hit, miss, bypass)",
      ["route", "result"],
    ),
    cacheBypassSeconds: registry.counter(
      METRIC_FAMILIES.cacheBypassSeconds,
      "Seconds spent rendering pages that bypassed the cache",
      ["route"],
    ),
    cacheUntrustedSeconds: registry.counter(
      METRIC_FAMILIES.cacheUntrustedSeconds,
      "Seconds the cache invalidation listener was untrusted (fail closed)",
    ),
    cacheVariants: registry.gauge(
      METRIC_FAMILIES.cacheVariants,
      "Distinct cache variants seen per route (excluding route parameters)",
      ["route"],
    ),
    queueDepth: registry.gauge(METRIC_FAMILIES.queueDepth, "Jobs waiting per queue", ["queue"]),
    queueLag: registry.gauge(METRIC_FAMILIES.queueLag, "Age of the oldest runnable job per queue", [
      "queue",
    ]),
    deadLetters: registry.gauge(
      METRIC_FAMILIES.deadLetters,
      "Jobs that exhausted their retries per queue",
      ["queue"],
    ),
    outboxLag: registry.gauge(
      METRIC_FAMILIES.outboxLag,
      "Age of the oldest unpublished outbox event",
    ),
    sseConnections: registry.gauge(METRIC_FAMILIES.sseConnections, "Open SSE streams"),
    pluginHookDuration: registry.histogram(
      METRIC_FAMILIES.pluginHookDuration,
      "Plugin hook call duration",
      ["plugin", "hook", "outcome"],
    ),
    pluginBreakerTrips: registry.counter(
      METRIC_FAMILIES.pluginBreakerTrips,
      "Plugins auto-disabled by the circuit breaker",
      ["plugin"],
    ),
    dbPoolConnections: registry.gauge(
      METRIC_FAMILIES.dbPoolConnections,
      "Database connections held by this service's role, by state",
      ["state"],
    ),
    dbPoolMax: registry.gauge(METRIC_FAMILIES.dbPoolMax, "Configured query pool size"),
  };
}

/** The process-wide registry every package records into. */
export const metrics = new MetricsRegistry();
export const standardMetrics: StandardMetrics = declareStandardMetrics(metrics);

const NUMERIC_SEGMENT = /^\d+(?:-[^/]*)?$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Collapses a request path into a bounded route label: numeric IDs (and `id-slug` segments)
 * become `:id`, UUIDs `:uuid`, and long or opaque tails `:param`.
 */
export function routeLabel(pathname: string): string {
  const segments = pathname.split("/").filter((segment) => segment !== "");

  if (segments.length === 0) {
    return "/";
  }

  return `/${segments
    .slice(0, 6)
    .map((segment) =>
      NUMERIC_SEGMENT.test(segment)
        ? ":id"
        : UUID_SEGMENT.test(segment)
          ? ":uuid"
          : segment.length > 40
            ? ":param"
            : segment,
    )
    .join("/")}`;
}

/** The fixed label for requests that match no known route (ADR 0020: bounded series). */
export const UNMATCHED_ROUTE = "unmatched";
/** Heuristic labels admitted per process before everything else becomes {@link UNMATCHED_ROUTE}. */
export const DEFAULT_ROUTE_LABEL_LIMIT = 100;
const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Bounds the method label: anything outside the standard methods is `other`. */
export function methodLabel(method: string): string {
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : "other";
}

function patternMatches(pattern: readonly string[], segments: readonly string[]): boolean {
  if (pattern.length !== segments.length) {
    return false;
  }

  return pattern.every(
    (part, index) =>
      part.startsWith(":") ||
      (part.startsWith("{") && part.endsWith("}")) ||
      (part.startsWith("[") && part.endsWith("]")) ||
      part === segments[index],
  );
}

export interface RouteLabeler {
  /** The declared route pattern the path matches, or null. */
  match(pathname: string): string | null;
  /**
   * The metric label for a finished request. Declared routes keep their pattern. Any other
   * path is `unmatched` when the response was 404/405, and otherwise gets a heuristic label
   * only while fewer than `maxLabels` distinct ones have been seen, so unauthenticated
   * requests to made-up paths cannot grow the series without bound.
   */
  label(pathname: string, status: number): string;
}

export function createRouteLabeler(
  options: { readonly patterns?: readonly string[]; readonly maxLabels?: number } = {},
): RouteLabeler {
  const patterns = [...new Set(options.patterns ?? [])].map((pattern) => ({
    pattern,
    parts: pattern.split("/").filter((part) => part !== ""),
  }));
  const maxLabels = options.maxLabels ?? DEFAULT_ROUTE_LABEL_LIMIT;
  const admitted = new Set<string>();

  const match = (pathname: string): string | null => {
    const segments = pathname.split("/").filter((segment) => segment !== "");
    return patterns.find((entry) => patternMatches(entry.parts, segments))?.pattern ?? null;
  };

  return {
    match,
    label(pathname, status) {
      const matched = match(pathname);

      if (matched !== null) {
        return matched;
      }

      if (status === 404 || status === 405) {
        return UNMATCHED_ROUTE;
      }

      const heuristic = routeLabel(pathname);

      if (admitted.has(heuristic)) {
        return heuristic;
      }

      if (admitted.size >= maxLabels) {
        return UNMATCHED_ROUTE;
      }

      admitted.add(heuristic);
      return heuristic;
    },
  };
}

export interface MetricSample {
  readonly name: string;
  readonly labels: Labels;
  readonly value: number;
}

function parseLabels(body: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

  for (const match of body.matchAll(pattern)) {
    const [, name, raw] = match;

    if (name !== undefined && raw !== undefined) {
      labels[name] = raw.replaceAll('\\"', '"').replaceAll("\\n", "\n").replaceAll("\\\\", "\\");
    }
  }

  return labels;
}

function parseNumber(raw: string): number {
  if (raw === "+Inf") {
    return Number.POSITIVE_INFINITY;
  }

  if (raw === "-Inf") {
    return Number.NEGATIVE_INFINITY;
  }

  return Number(raw);
}

/** Parses the text exposition format into samples (comments are skipped). */
export function parsePrometheusText(text: string): MetricSample[] {
  const samples: MetricSample[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const brace = trimmed.indexOf("{");
    const close = trimmed.lastIndexOf("}");
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;

    if (brace !== -1 && close > brace) {
      name = trimmed.slice(0, brace);
      labels = parseLabels(trimmed.slice(brace + 1, close));
      rest = trimmed.slice(close + 1).trim();
    } else {
      const space = trimmed.indexOf(" ");
      name = trimmed.slice(0, space);
      rest = trimmed.slice(space + 1).trim();
    }

    const value = parseNumber(rest.split(/\s+/)[0] ?? "");

    if (NAME.test(name) && !Number.isNaN(value)) {
      samples.push({ name, labels, value });
    }
  }

  return samples;
}

/** Lists the `# TYPE` family names in an exposition. */
export function exposedFamilies(text: string): Set<string> {
  const families = new Set<string>();

  for (const line of text.split("\n")) {
    const match = /^# TYPE (\S+) \S+/.exec(line);

    if (match?.[1] !== undefined) {
      families.add(match[1]);
    }
  }

  return families;
}

/** Serves `/metrics` from a registry on its own (internal) port. */
export function serveMetrics(options: {
  readonly port: number;
  readonly hostname?: string;
  readonly registry?: MetricsRegistry;
}): ReturnType<typeof Bun.serve> {
  const registry = options.registry ?? metrics;

  return Bun.serve({
    port: options.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname !== "/metrics" || request.method !== "GET") {
        return new Response("Not found", { status: 404 });
      }

      return new Response(await registry.expose(), {
        headers: { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" },
      });
    },
  });
}

/** The internal metrics port every service listens on (never published by the proxy). */
export const DEFAULT_METRICS_PORT = 9464;

/** `BULLETIN_METRICS_PORT`: a port number, or `off` to disable the endpoint. */
export function metricsPortFromEnv(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): number | null {
  const raw = env.BULLETIN_METRICS_PORT?.trim();

  if (raw === undefined || raw === "") {
    return DEFAULT_METRICS_PORT;
  }

  if (raw === "off") {
    return null;
  }

  const port = Number(raw);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BULLETIN_METRICS_PORT must be a port number or 'off'");
  }

  return port;
}
