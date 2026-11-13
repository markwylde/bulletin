/**
 * Per-plugin request budgets for the broker (ADR 0009).
 *
 * Postgres work is not bounded by the sandbox cgroups, so the broker limits how many
 * statements one plugin may run at once and how many it may start per second. Egress uses
 * the same shape so one plugin cannot saturate the proxy.
 */

export class BrokerLimitError extends Error {
  readonly reason: "rate" | "concurrency";

  constructor(reason: "rate" | "concurrency", message: string) {
    super(message);
    this.name = "BrokerLimitError";
    this.reason = reason;
  }
}

/** Token bucket with a one-second refill and a burst equal to the rate by default. */
export class TokenBucket {
  readonly #ratePerSecond: number;
  readonly #burst: number;
  readonly #now: () => number;
  #tokens: number;
  #lastRefill: number;

  constructor(ratePerSecond: number, options: { burst?: number; now?: () => number } = {}) {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
      throw new TypeError("ratePerSecond must be positive");
    }

    const burst = options.burst ?? Math.max(1, Math.ceil(ratePerSecond));

    if (!Number.isFinite(burst) || burst <= 0) {
      throw new TypeError("burst must be positive");
    }

    this.#ratePerSecond = ratePerSecond;
    this.#burst = burst;
    this.#now = options.now ?? (() => performance.now());
    this.#tokens = burst;
    this.#lastRefill = this.#now();
  }

  get tokens(): number {
    this.#refill();
    return this.#tokens;
  }

  take(): boolean {
    this.#refill();

    if (this.#tokens < 1) {
      return false;
    }

    this.#tokens -= 1;
    return true;
  }

  #refill(): void {
    const now = this.#now();
    const elapsed = Math.max(0, now - this.#lastRefill);
    this.#lastRefill = now;
    this.#tokens = Math.min(this.#burst, this.#tokens + (elapsed / 1_000) * this.#ratePerSecond);
  }
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Bounded concurrency with a FIFO queue. A request waits for a slot only until its deadline,
 * so one busy plugin fails its own call without blocking other plugins.
 */
export class ConcurrencyGate {
  readonly #max: number;
  readonly #waitTimeoutMs: number;
  readonly #waiters: Waiter[] = [];
  #active = 0;

  constructor(max: number, options: { waitTimeoutMs?: number } = {}) {
    if (!Number.isInteger(max) || max <= 0) {
      throw new TypeError("Concurrency limit must be a positive integer");
    }

    this.#max = max;
    this.#waitTimeoutMs = options.waitTimeoutMs ?? 2_000;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();

    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);

        if (index !== -1) {
          this.#waiters.splice(index, 1);
        }

        reject(
          new BrokerLimitError(
            "concurrency",
            `Too many concurrent broker requests (limit ${this.#max})`,
          ),
        );
      }, this.#waitTimeoutMs);
      timer.unref?.();

      this.#waiters.push({ resolve, reject, timer });
    });
  }

  #release(): void {
    const waiter = this.#waiters.shift();

    if (waiter === undefined) {
      this.#active = Math.max(0, this.#active - 1);
      return;
    }

    clearTimeout(waiter.timer);
    // Hand the slot directly to the next waiter so `active` never drops below the limit.
    waiter.resolve();
  }
}

export interface BrokerLimitOptions {
  /** Concurrent database statements per plugin. ADR 0009 sets this to 2. */
  readonly maxConcurrentDb?: number;
  /** Database statements started per second per plugin. */
  readonly dbStatementsPerSecond?: number;
  /** Concurrent egress requests per plugin. */
  readonly maxConcurrentEgress?: number;
  /** Egress requests started per second per plugin. */
  readonly egressRequestsPerSecond?: number;
  /** How long a request waits for a concurrency slot before failing. */
  readonly waitTimeoutMs?: number;
}

export const DEFAULT_BROKER_LIMITS: Required<BrokerLimitOptions> = {
  maxConcurrentDb: 2,
  dbStatementsPerSecond: 20,
  maxConcurrentEgress: 2,
  egressRequestsPerSecond: 10,
  waitTimeoutMs: 2_000,
};

export interface BrokerBudgets {
  readonly dbGate: ConcurrencyGate;
  readonly dbRate: TokenBucket;
  readonly egressGate: ConcurrencyGate;
  readonly egressRate: TokenBucket;
}

export function createBrokerBudgets(options: BrokerLimitOptions = {}): BrokerBudgets {
  const merged = { ...DEFAULT_BROKER_LIMITS, ...options };

  return {
    dbGate: new ConcurrencyGate(merged.maxConcurrentDb, {
      waitTimeoutMs: merged.waitTimeoutMs,
    }),
    dbRate: new TokenBucket(merged.dbStatementsPerSecond),
    egressGate: new ConcurrencyGate(merged.maxConcurrentEgress, {
      waitTimeoutMs: merged.waitTimeoutMs,
    }),
    egressRate: new TokenBucket(merged.egressRequestsPerSecond),
  };
}
