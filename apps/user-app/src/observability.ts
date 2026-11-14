import { metricsPortFromEnv, serveMetrics } from "@bulletin/config/metrics";
import { registerDbPoolCollector } from "@bulletin/config/server";
import { initTracing } from "@bulletin/config/tracing";
import { READ_POOL_MAX, readSql } from "./db.ts";

const STARTED = Symbol.for("bulletin.user-app.metrics");

/**
 * Starts the internal `/metrics` listener once per process (ADR 0020). Astro's dev server can
 * re-evaluate modules, so the guard lives on `globalThis`; a port that is already bound by an
 * earlier evaluation is left alone.
 */
export function startUserAppMetrics(): void {
  const state = globalThis as typeof globalThis & { [STARTED]?: boolean };

  if (state[STARTED] === true) {
    return;
  }

  state[STARTED] = true;
  initTracing({ service: "user-app" });
  const port = metricsPortFromEnv();

  if (port === null) {
    return;
  }

  registerDbPoolCollector(readSql(), "user-app", undefined, undefined, { poolMax: READ_POOL_MAX });

  try {
    serveMetrics({ port });
  } catch (error) {
    console.warn("[metrics] the user-app metrics listener could not start", error);
  }
}
