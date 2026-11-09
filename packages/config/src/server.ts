import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { SQL as BunSQL } from "bun";
import {
  assertConnectionBudget,
  type ConnectionBudgetResult,
  type ConnectionShare,
  connectionPoolSize,
  type ServiceName,
} from "./connections.ts";

export interface HealthCheck {
  readonly name: string;
  check(): boolean | Promise<boolean>;
}

export interface ConnectionBudgetConfig {
  readonly sql: SQL;
  readonly service: ServiceName;
  readonly reserve?: number;
  readonly replicas?: Partial<Record<ServiceName, number>>;
  readonly connections?: Partial<Record<ServiceName, ConnectionShare>>;
  /** Test/ops override; otherwise read `max_connections` from Postgres. */
  readonly maxConnections?: number;
}

export interface StartServiceOptions {
  readonly service: string;
  readonly port: number;
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly checks?: readonly HealthCheck[];
  readonly drainTimeoutMs?: number;
  readonly installSignalHandlers?: boolean;
  readonly budget?: ConnectionBudgetConfig;
  readonly onShutdown?: () => Promise<void>;
}

export interface RunningService {
  readonly server: ReturnType<typeof Bun.serve>;
  shutdown(): Promise<void>;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

export function createDatabaseCheck(sql: SQL): HealthCheck {
  return {
    name: "database",
    async check() {
      await sql`SELECT 1`;
      return true;
    },
  };
}

export interface ListenerCheck extends HealthCheck {
  close(): Promise<void>;
}

/**
 * Verifies the dedicated LISTEN connection by sending a token through NOTIFY and waiting
 * for the listener callback. Failures and reconnects make readiness fail until a notification
 * arrives again.
 */
export async function createListenerCheck(
  sql: SQL,
  channel = "bulletin_health",
): Promise<ListenerCheck> {
  let pending: ((ok: boolean) => void) | undefined;
  let expected: string | undefined;
  let closed = false;

  const subscription = await sql.listen(channel, (payload) => {
    if (pending !== undefined && payload === expected) {
      pending(true);
    }
  });

  return {
    name: "listener",
    check() {
      if (closed) {
        return Promise.resolve(false);
      }

      return new Promise<boolean>((resolve) => {
        const token = randomUUID();
        expected = token;

        const timer = setTimeout(() => {
          if (pending !== undefined) {
            pending(false);
          }
        }, 1_000);

        pending = (ok) => {
          clearTimeout(timer);
          pending = undefined;
          resolve(ok);
        };

        void sql.notify(channel, token).catch(() => {
          if (pending !== undefined) {
            pending(false);
          }
        });
      });
    },
    async close() {
      closed = true;
      pending?.(false);
      await subscription.unlisten();
    },
  };
}

export async function readMaxConnections(sql: SQL): Promise<number> {
  const rows = (await sql`SHOW max_connections`) as Array<{ max_connections: string }>;
  const value = Number(rows[0]?.max_connections ?? 0);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Could not read a positive Postgres max_connections");
  }

  return value;
}

async function checkBudget(config: ConnectionBudgetConfig): Promise<ConnectionBudgetResult> {
  const maxConnections = config.maxConnections ?? (await readMaxConnections(config.sql));

  return assertConnectionBudget({
    maxConnections,
    ...(config.reserve === undefined ? {} : { reserve: config.reserve }),
    ...(config.replicas === undefined ? {} : { replicas: config.replicas }),
    ...(config.connections === undefined ? {} : { connections: config.connections }),
  });
}

/** Creates the service's SQL pool with the same pool limit used by the budget. */
export function createServiceSql(
  service: ServiceName,
  databaseUrl: string,
  connections?: Partial<Record<ServiceName, ConnectionShare>>,
): SQL {
  return new BunSQL(databaseUrl, { max: connectionPoolSize(service, connections) });
}

/**
 * Starts a Bun service with the shared health endpoints and SIGTERM drain (ADR 0020).
 * Readiness fails first, then the listener stops accepting; in-flight requests get up to
 * `drainTimeoutMs` before connections are closed.
 */
export async function startService(options: StartServiceOptions): Promise<RunningService> {
  if (options.budget !== undefined) {
    await checkBudget(options.budget);
  }

  let draining = false;
  let active = 0;
  let idleResolve: (() => void) | undefined;

  const becomeIdle = (): void => {
    if (active === 0 && idleResolve !== undefined) {
      const resolve = idleResolve;
      idleResolve = undefined;
      resolve();
    }
  };

  const waitForIdle = (): Promise<void> =>
    active === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          idleResolve = resolve;
        });

  const readiness = async (): Promise<Response> => {
    if (draining) {
      return Response.json({ status: "draining", checks: {} }, { status: 503 });
    }

    const checks: Record<string, boolean> = {};
    let ready = true;

    for (const check of options.checks ?? []) {
      try {
        checks[check.name] = await check.check();
      } catch {
        checks[check.name] = false;
      }

      if (checks[check.name] !== true) {
        ready = false;
      }
    }

    return Response.json(
      { status: ready ? "ok" : "unavailable", checks },
      { status: ready ? 200 : 503 },
    );
  };

  const server = Bun.serve({
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health/live") {
        return Response.json({ status: "ok", service: options.service });
      }

      if (url.pathname === "/health/ready") {
        return readiness();
      }

      active += 1;

      try {
        return await options.fetch(request);
      } finally {
        active -= 1;
        becomeIdle();
      }
    },
  });

  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      draining = true;
      server.stop(false);

      const workerShutdown = options.onShutdown?.() ?? Promise.resolve();
      const workerDone = workerShutdown.catch(() => undefined);

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);

        void Promise.all([waitForIdle(), workerDone]).then(finish);
      });

      server.stop(true);
    })();

    return shutdownPromise;
  };

  if (options.installSignalHandlers !== false) {
    const onSignal = (): void => {
      void shutdown().finally(() => process.exit(0));
    };

    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  return { server, shutdown };
}
