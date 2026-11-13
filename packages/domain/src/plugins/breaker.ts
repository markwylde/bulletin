import type { SQL } from "bun";
import { queueSystemAudit } from "../audit/index.ts";

/**
 * Circuit breaker for plugin hooks/jobs (ADR 0009). A plugin that fails the same hook on 50
 * consecutive calls is auto-disabled and admins are notified with the failing hook's name.
 * A success resets the consecutive counter.
 */

export const BREAKER_THRESHOLD = 50;

export interface CircuitBreakerOptions {
  readonly sql: SQL;
  readonly disable: (pluginId: string, reason: string) => Promise<void>;
  readonly threshold?: number;
}

export interface FailureResult {
  readonly failures: number;
  readonly disabled: boolean;
}

export class PluginCircuitBreaker {
  readonly #sql: SQL;
  readonly #disable: (pluginId: string, reason: string) => Promise<void>;
  readonly #threshold: number;

  constructor(options: CircuitBreakerOptions) {
    this.#sql = options.sql;
    this.#disable = options.disable;
    this.#threshold = options.threshold ?? BREAKER_THRESHOLD;
  }

  /** Records one failed hook/job call; disables the plugin at the threshold. */
  async recordFailure(pluginId: string, hook: string, error: unknown): Promise<FailureResult> {
    const message = error instanceof Error ? error.message : String(error);
    const rows = (await this.#sql`
      INSERT INTO core.plugin_breaker (plugin_id, hook, failures, last_error, updated_at)
      VALUES (${pluginId}, ${hook}, 1, ${message}, now())
      ON CONFLICT (plugin_id, hook) DO UPDATE SET
        failures = core.plugin_breaker.failures + 1,
        last_error = EXCLUDED.last_error,
        updated_at = now()
      RETURNING failures
    `) as Array<{ failures: number }>;
    const failures = rows[0]?.failures ?? 1;

    if (failures < this.#threshold) {
      return { failures, disabled: false };
    }

    await this.#sql`
      UPDATE core.plugin_breaker
      SET disabled_at = now(), updated_at = now()
      WHERE plugin_id = ${pluginId} AND hook = ${hook}
    `;
    await this.#disable(pluginId, `circuit breaker: ${hook} failed ${String(failures)} times`);
    await queueSystemAudit(this.#sql, {
      action: "plugin.auto_disabled",
      targetType: "plugin",
      summary: { pluginId, hook, failures },
    });
    return { failures, disabled: true };
  }

  async recordSuccess(pluginId: string, hook: string): Promise<void> {
    await this.#sql`
      UPDATE core.plugin_breaker
      SET failures = 0, updated_at = now()
      WHERE plugin_id = ${pluginId} AND hook = ${hook}
    `;
  }

  /** Breaker status for the staff plugin manager. */
  async status(
    pluginId: string,
  ): Promise<readonly { hook: string; failures: number; disabledAt: string | null }[]> {
    const rows = (await this.#sql`
      SELECT hook, failures, disabled_at::text AS disabled_at
      FROM core.plugin_breaker
      WHERE plugin_id = ${pluginId}
      ORDER BY hook
    `) as Array<{ hook: string; failures: number; disabled_at: string | null }>;

    return rows.map((row) => ({
      hook: row.hook,
      failures: row.failures,
      disabledAt: row.disabled_at,
    }));
  }
}
