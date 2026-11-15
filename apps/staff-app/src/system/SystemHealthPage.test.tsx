import { describe, expect, test } from "bun:test";
import { I18nProvider } from "@bulletin/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import messages from "../../i18n/merged/en.json";
import { SystemHealthPage, type SystemHealthReport } from "./SystemHealthPage.tsx";

const report: SystemHealthReport = {
  generatedAt: "2026-11-14T12:00:00.000Z",
  status: "degraded",
  services: [
    { name: "staff-api", ready: true, reachable: true, checks: { database: true } },
    { name: "workers", ready: false, reachable: false, checks: {} },
  ],
  queues: [
    { queue: "email", depth: 2, lagSeconds: 3, active: 0, deadLetters: 0, lagging: false },
    {
      queue: "notifications",
      depth: 40,
      lagSeconds: 45,
      active: 1,
      deadLetters: 2,
      lagging: true,
    },
  ],
  queueLagWarningSeconds: 30,
  deadLetters: 2,
  outbox: { unpublished: 0, lagSeconds: 0 },
  cache: {
    hits: 90,
    misses: 10,
    bypasses: 0,
    hitRate: 0.9,
    bypassSeconds: 0,
    untrustedSeconds: 0,
  },
  variantBudget: 64,
  variants: [{ route: "/topic/[id]", variants: 80, overBudget: true }],
  pools: [{ service: "user-api", inUse: 9, open: 10, max: 10, saturation: 0.9 }],
  plugins: [
    {
      pluginId: "demo",
      state: "disabled",
      enabled: false,
      failingHooks: 50,
      breakerTripped: true,
      healthy: false,
    },
  ],
  sseConnections: 3,
};

function render(): string {
  const client = new QueryClient();
  client.setQueryData(["staff", "system", "health"], report);

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" messages={messages}>
        <SystemHealthPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("system health panel", () => {
  test("highlights a queue whose lag exceeds 30 seconds", () => {
    const html = render();

    expect(html).toContain('data-queue="notifications" data-queue-lagging="true"');
    expect(html).toMatch(/class="list-row is-warning" data-queue="notifications"/);
    expect(html).toContain('data-queue="email" data-queue-lagging="false"');
    expect(html).toContain("Falling behind");
  });

  test("shows readiness, cache, variant warnings, pools and plugin health", () => {
    const html = render();

    expect(html).toContain('data-health-status="degraded"');
    expect(html).toContain('data-health-service="workers" data-health-ok="false"');
    expect(html).toContain("Unreachable");
    expect(html).toContain("90%");
    expect(html).toContain('data-variant-over-budget="true"');
    expect(html).toContain("9 of 10 in use (90%)");
    expect(html).toContain("Disabled by the circuit breaker");
  });
});
