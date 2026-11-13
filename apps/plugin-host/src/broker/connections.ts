import { SQL } from "bun";
import { pluginIdentifiers } from "./database.ts";

/**
 * Broker-wide connection budget (ADR 0009, ADR 0020).
 *
 * Plugin roles are opened lazily on their first statement, closed after 10 s idle, and
 * bounded by one semaphore for the whole plugin-host. Every pool holds exactly one Postgres
 * connection, so the number of open pools is the number of connections: the budget from
 * ADR 0020 can never be exceeded by opening one more pool per plugin. When every slot is
 * held, a waiting plugin's call fails after its own deadline; other plugins keep working.
 * Enabling more plugins than the budget can therefore never break startup.
 */

export const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
/** ADR 0020's plugin-host connection share, per replica. */
export const DEFAULT_MAX_CONNECTIONS = 20;
export const DEFAULT_WAIT_TIMEOUT_MS = 2_000;

export class ConnectionBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionBudgetError";
  }
}

export type ConnectionFactory = (pluginId: string) => SQL;

interface OpenConnection {
  readonly sql: SQL;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  active: number;
  closed: boolean;
}

export interface PluginConnectionManagerOptions {
  readonly adminUrl: string;
  /** Maximum Postgres connections open at once across every plugin (ADR 0020). */
  readonly maxConnections?: number;
  /** Close an idle plugin pool after this long. */
  readonly idleTimeoutMs?: number;
  /** How long a plugin waits for a free budget slot before failing its own call. */
  readonly waitTimeoutMs?: number;
  /** Test seam: create the runtime pool for a plugin. */
  readonly createPool?: ConnectionFactory;
}

export interface ConnectionManagerStats {
  /** Open pools; every pool holds one Postgres connection. */
  readonly open: number;
  readonly maxConnections: number;
  readonly waiting: number;
  readonly opened: number;
  readonly closed: number;
  readonly rejections: number;
}

interface Waiter {
  readonly pluginId: string;
  readonly resolve: (connection: OpenConnection) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function runtimeUrl(adminUrl: string, role: string): string {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

export class PluginConnectionManager {
  readonly #adminUrl: string;
  readonly #maxConnections: number;
  readonly #idleTimeoutMs: number;
  readonly #waitTimeoutMs: number;
  readonly #createPool: ConnectionFactory;
  readonly #connections = new Map<string, OpenConnection>();
  readonly #waiters: Waiter[] = [];
  #opened = 0;
  #closed = 0;
  #rejections = 0;

  constructor(options: PluginConnectionManagerOptions) {
    this.#adminUrl = options.adminUrl;
    this.#maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.#createPool =
      options.createPool ??
      ((pluginId) => {
        const role = pluginIdentifiers(pluginId).runtimeRole;
        return new SQL(runtimeUrl(this.#adminUrl, role), {
          // One connection per open pool keeps the pool count equal to the connection count.
          max: 1,
          connectionTimeout: 5,
        });
      });
  }

  stats(): ConnectionManagerStats {
    return {
      open: this.#connections.size,
      maxConnections: this.#maxConnections,
      waiting: this.#waiters.length,
      opened: this.#opened,
      closed: this.#closed,
      rejections: this.#rejections,
    };
  }

  /** Runs `task` on the plugin's lazily-opened pool. */
  async withConnection<T>(pluginId: string, task: (sql: SQL) => Promise<T>): Promise<T> {
    const connection = await this.#acquire(pluginId);

    try {
      connection.active += 1;
      this.#armIdle(pluginId, connection);
      return await task(connection.sql);
    } finally {
      connection.active = Math.max(0, connection.active - 1);
      this.#armIdle(pluginId, connection);
    }
  }

  /** Closes every pool; used on shutdown. */
  async close(): Promise<void> {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new ConnectionBudgetError("The plugin-host is shutting down"));
    }

    const connections = [...this.#connections.entries()];

    for (const [, connection] of connections) {
      await this.#close(connection);
    }

    this.#connections.clear();
  }

  async #acquire(pluginId: string): Promise<OpenConnection> {
    const existing = this.#connections.get(pluginId);

    if (existing !== undefined) {
      return existing;
    }

    if (this.#connections.size < this.#maxConnections) {
      return this.#open(pluginId);
    }

    return new Promise<OpenConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);

        if (index !== -1) {
          this.#waiters.splice(index, 1);
        }

        this.#rejections += 1;
        reject(
          new ConnectionBudgetError(
            `The plugin-host connection budget (${this.#maxConnections} connections) is exhausted`,
          ),
        );
      }, this.#waitTimeoutMs);
      timer.unref?.();

      this.#waiters.push({ pluginId, resolve, reject, timer });
    });
  }

  async #open(pluginId: string): Promise<OpenConnection> {
    const connection: OpenConnection = {
      sql: this.#createPool(pluginId),
      idleTimer: undefined,
      active: 0,
      closed: false,
    };
    this.#connections.set(pluginId, connection);
    this.#opened += 1;

    try {
      await connection.sql`SELECT 1`;
    } catch (error) {
      this.#connections.delete(pluginId);
      await this.#close(connection);
      throw error;
    }

    this.#armIdle(pluginId, connection);
    return connection;
  }

  #armIdle(pluginId: string, connection: OpenConnection): void {
    if (connection.closed) {
      return;
    }

    if (connection.idleTimer !== undefined) {
      clearTimeout(connection.idleTimer);
    }

    connection.idleTimer = setTimeout(() => {
      if (connection.active > 0) {
        this.#armIdle(pluginId, connection);
        return;
      }

      // A waiting plugin gets the slot directly as soon as this pool closes.
      this.#connections.delete(pluginId);
      void this.#close(connection).then(() => this.#handOff());
    }, this.#idleTimeoutMs);
    connection.idleTimer.unref?.();
  }

  async #close(connection: OpenConnection): Promise<void> {
    if (connection.closed) {
      return;
    }

    connection.closed = true;

    if (connection.idleTimer !== undefined) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }

    this.#closed += 1;
    await connection.sql.close().catch(() => undefined);
  }

  async #handOff(): Promise<void> {
    const waiter = this.#waiters.shift();

    if (waiter === undefined) {
      return;
    }

    clearTimeout(waiter.timer);

    if (this.#connections.size >= this.#maxConnections) {
      // Another waiter was handed the slot first; stay queued.
      this.#waiters.unshift(waiter);
      return;
    }

    try {
      waiter.resolve(await this.#open(waiter.pluginId));
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
