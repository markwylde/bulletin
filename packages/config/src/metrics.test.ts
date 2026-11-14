import { describe, expect, test } from "bun:test";
import {
  createRouteLabeler,
  declareStandardMetrics,
  exposedFamilies,
  METRIC_FAMILIES,
  MetricsRegistry,
  methodLabel,
  metricsPortFromEnv,
  parsePrometheusText,
  routeLabel,
  serveMetrics,
  UNMATCHED_ROUTE,
} from "./metrics.ts";

describe("metrics registry", () => {
  test("renders counters, gauges and histograms in the text format", async () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("demo_total", "A counter", ["kind"]);
    const gauge = registry.gauge("demo_gauge", "A gauge");
    const histogram = registry.histogram("demo_seconds", "A histogram", ["route"], [0.1, 1]);

    counter.inc({ kind: "a" });
    counter.inc({ kind: "a" }, 2);
    gauge.set({}, 4);
    histogram.observe({ route: "/x" }, 0.05);
    histogram.observe({ route: "/x" }, 0.5);

    const text = await registry.expose();

    expect(text).toContain("# TYPE demo_total counter");
    expect(text).toContain('demo_total{kind="a"} 3');
    expect(text).toContain("demo_gauge 4");
    expect(text).toContain('demo_seconds_bucket{le="0.1",route="/x"} 1');
    expect(text).toContain('demo_seconds_bucket{le="1",route="/x"} 2');
    expect(text).toContain('demo_seconds_bucket{le="+Inf",route="/x"} 2');
    expect(text).toContain('demo_seconds_count{route="/x"} 2');

    const samples = parsePrometheusText(text);
    expect(samples.find((sample) => sample.name === "demo_total")?.value).toBe(3);
    expect(
      samples.find((sample) => sample.name === "demo_seconds_bucket" && sample.labels.le === "+Inf")
        ?.value,
    ).toBe(2);
  });

  test("rejects unknown labels and decreasing counters", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("strict_total", "Strict", ["a"]);

    expect(() => counter.inc({ b: "x" })).toThrow();
    expect(() => counter.inc({ a: "x" }, -1)).toThrow();
    expect(() => registry.gauge("strict_total", "Clash")).toThrow();
  });

  test("escapes label values and parses them back", async () => {
    const registry = new MetricsRegistry();
    registry.gauge("escaped", "Escaping", ["route"]).set({ route: 'a"b\\c' }, 1);
    const samples = parsePrometheusText(await registry.expose());

    expect(samples[0]?.labels.route).toBe('a"b\\c');
  });

  test("runs collectors at scrape time and survives a failing one", async () => {
    const registry = new MetricsRegistry();
    const gauge = registry.gauge("collected", "Collected");
    let calls = 0;
    registry.addCollector(() => {
      calls += 1;
      gauge.set({}, calls);
    });
    registry.addCollector(() => {
      throw new Error("down");
    });

    expect(await registry.expose()).toContain("collected 1");
    expect(await registry.expose()).toContain("collected 2");
  });

  test("declares every ADR 0020 family, even before the first sample", async () => {
    const registry = new MetricsRegistry();
    declareStandardMetrics(registry);
    const families = exposedFamilies(await registry.expose());

    for (const family of Object.values(METRIC_FAMILIES)) {
      expect(families.has(family)).toBe(true);
    }
  });

  test("route labels stay bounded", () => {
    expect(routeLabel("/")).toBe("/");
    expect(routeLabel("/topic/345-welcome/page/2")).toBe("/topic/:id/page/:id");
    expect(routeLabel("/api/staff/events/dead-letters")).toBe("/api/staff/events/dead-letters");
    expect(routeLabel("/x/0b2f4c3e-1a2b-4c5d-8e9f-0123456789ab")).toBe("/x/:uuid");
  });

  test("the metrics port comes from the environment", () => {
    expect(metricsPortFromEnv({})).toBe(9464);
    expect(metricsPortFromEnv({ BULLETIN_METRICS_PORT: "off" })).toBeNull();
    expect(metricsPortFromEnv({ BULLETIN_METRICS_PORT: "9100" })).toBe(9100);
    expect(() => metricsPortFromEnv({ BULLETIN_METRICS_PORT: "nope" })).toThrow();
  });

  test("serves /metrics only", async () => {
    const registry = new MetricsRegistry();
    registry.counter("served_total", "Served").inc();
    const server = serveMetrics({ port: 0, hostname: "127.0.0.1", registry });

    try {
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/metrics`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toContain("served_total 1");
      expect((await fetch(`${base}/`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe("bounded route labels", () => {
  test("declared patterns win; 404s and overflow collapse to one label", () => {
    const labeler = createRouteLabeler({
      patterns: ["/api/v1/forums/:id", "/topic/[id]"],
      maxLabels: 2,
    });

    expect(labeler.label("/api/v1/forums/12", 200)).toBe("/api/v1/forums/:id");
    expect(labeler.label("/topic/12-hello", 200)).toBe("/topic/[id]");
    expect(labeler.label("/api/v1/forums/12/extra", 404)).toBe(UNMATCHED_ROUTE);
    expect(labeler.label("/a", 401)).toBe("/a");
    expect(labeler.label("/b", 401)).toBe("/b");
    expect(labeler.label("/c", 401)).toBe(UNMATCHED_ROUTE);
    expect(labeler.label("/a", 200)).toBe("/a");
  });

  test("methods outside the standard set are labelled other", () => {
    expect(methodLabel("get")).toBe("GET");
    expect(methodLabel("PROPFIND")).toBe("other");
  });
});
