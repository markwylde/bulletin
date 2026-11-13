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
  readonly resolve: (connection: OpenConnection) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One group per plugin, so concurrent same-plugin callers share a pending acquisition. */
interface WaiterGroup {
  readonly pluginId: string;
  readonly waiters: Waiter[];
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
  /** A plug-in's acquisition is shared by every concurrent caller; it reserves its slot. */
  readonly #pending = new Map<string, Promise<OpenConnection>>();
  readonly #waiters = new Map<string, WaiterGroup>();
  #closing = false;
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
      waiting: [...this.#waiters.values()].reduce(
        (count, group) => count + group.waiters.length,
        0,
      ),
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
    this.#closing = true;

    for (const group of this.#waiters.values()) {
      for (const waiter of group.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new ConnectionBudgetError("The plugin-host is shutting down"));
      }
    }

    this.#waiters.clear();

    // An acquisition already in flight still reserves a slot; wait for it, then close it
    // with everything else so shutdown cannot leave an orphan connection behind.
    await Promise.allSettled([...this.#pending.values()]);
    const connections = [...this.#connections.values()];

    for (const connection of connections) {
      await this.#close(connection);
    }

    this.#connections.clear();
  }

  async #acquire(pluginId: string): Promise<OpenConnection> {
    if (this.#closing) {
      throw new ConnectionBudgetError("The plugin-host is shutting down");
    }

    const existing = this.#connections.get(pluginId);

    if (existing !== undefined) {
      return existing;
    }

    const pending = this.#pending.get(pluginId);

    if (pending !== undefined) {
      return pending;
    }

    if (this.#slots() < this.#maxConnections) {
      return this.#start(pluginId);
    }

    return this.#wait(pluginId);
  }

  /** Slots in use, counting a pool that is still opening but not yet in `#connections`. */
  #slots(): number {
    let count = this.#connections.size;

    for (const pluginId of this.#pending.keys()) {
      if (!this.#connections.has(pluginId)) {
        count += 1;
      }
    }

    return count;
  }

  /** Starts one acquisition per plugin and shares it with every concurrent caller. */
  #start(pluginId: string): Promise<OpenConnection> {
    const pending = this.#open(pluginId).then(
      (connection) => {
        this.#pending.delete(pluginId);
        return connection;
      },
      (error: unknown) => {
        this.#pending.delete(pluginId);
        void this.#handOff();
        throw error;
      },
    );
    this.#pending.set(pluginId, pending);
    return pending;
  }

  #wait(pluginId: string): Promise<OpenConnection> {
    let group = this.#waiters.get(pluginId);

    if (group === undefined) {
      group = { pluginId, waiters: [] };
      this.#waiters.set(pluginId, group);
    }

    const current = group;

    return new Promise<OpenConnection>((resolve, reject) => {
      const waiter = { resolve, reject } as Waiter;
      waiter.timer = setTimeout(() => {
        this.#removeWaiter(current, waiter);
        this.#rejections += 1;
        reject(
          new ConnectionBudgetError(
            `The plugin-host connection budget (${this.#maxConnections} connections) is exhausted`,
          ),
        );
      }, this.#waitTimeoutMs);
      waiter.timer.unref?.();
      current.waiters.push(waiter);
    });
  }

  #removeWaiter(group: WaiterGroup, waiter: Waiter): void {
    const index = group.waiters.indexOf(waiter);

    if (index !== -1) {
      group.waiters.splice(index, 1);
    }

    if (group.waiters.length === 0 && this.#waiters.get(group.pluginId) === group) {
      this.#waiters.delete(group.pluginId);
    }
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
    if (this.#closing) {
      return;
    }

    const next = this.#waiters.values().next().value as WaiterGroup | undefined;

    if (next === undefined || this.#slots() >= this.#maxConnections) {
      return;
    }

    this.#waiters.delete(next.pluginId);

    for (const waiter of next.waiters) {
      clearTimeout(waiter.timer);
    }

    try {
      const connection = await this.#acquire(next.pluginId);

      for (const waiter of next.waiters) {
        waiter.resolve(connection);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));

      for (const waiter of next.waiters) {
        waiter.reject(failure);
      }
    }
  }
}
