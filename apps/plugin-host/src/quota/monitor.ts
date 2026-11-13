import type { Logger } from "@bulletin/config";
import { SQL } from "bun";
import { pluginIdentifiers } from "../broker/database.ts";

/**
 * Bounds plugin schema growth (ADR 0009). Postgres has no per-schema quota, so a monitor
 * measures the schema every minute and, once over quota, revokes INSERT/UPDATE from the
 * runtime role. The role is not the owner, so the revoke sticks; reads and DELETEs keep
 * working so an admin can inspect or clean up. Writes stay off until an admin restores them.
 */

export const DEFAULT_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_QUOTA_INTERVAL_MS = 60_000;

export interface QuotaStatus {
  readonly pluginId: string;
  readonly schema: string;
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly exceeded: boolean;
  /** True once writes were revoked for exceeding the quota. */
  readonly writesRevoked: boolean;
  readonly checkedAt: string | null;
}

export interface PluginQuotaMonitorOptions {
  readonly adminUrl: string;
  readonly pluginId: string;
  readonly logger: Logger;
  readonly quotaBytes?: number;
  readonly intervalMs?: number;
}

export interface SharedClusterOptions {
  readonly nodeEnv: string;
  /** A separate plugin cluster when set (`PLUGIN_DATABASE_URL`). */
  readonly pluginDatabaseUrl?: string;
}

/**
 * Locally plugins share the core Postgres (ADR 0003). In production that means a hostile
 * plugin's DB work can affect core availability, so the staff app must warn unless
 * `PLUGIN_DATABASE_URL` points at a separate cluster.
 */
export function usesSharedPluginCluster(options: SharedClusterOptions): boolean {
  return (
    options.nodeEnv === "production" &&
    (options.pluginDatabaseUrl === undefined || options.pluginDatabaseUrl.trim() === "")
  );
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export class PluginQuotaMonitor {
  readonly pluginId: string;
  readonly schema: string;
  readonly quotaBytes: number;
  readonly #adminUrl: string;
  readonly #runtimeRole: string;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #checking: Promise<QuotaStatus> | undefined;
  #status: QuotaStatus;

  constructor(options: PluginQuotaMonitorOptions) {
    const identifiers = pluginIdentifiers(options.pluginId);
    this.pluginId = identifiers.pluginId;
    this.schema = identifiers.schema;
    this.quotaBytes = options.quotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES;
    this.#adminUrl = options.adminUrl;
    this.#runtimeRole = identifiers.runtimeRole;
    this.#logger = options.logger.child({ pluginId: options.pluginId });
    this.#intervalMs = options.intervalMs ?? DEFAULT_QUOTA_INTERVAL_MS;
    this.#status = {
      pluginId: this.pluginId,
      schema: this.schema,
      usedBytes: 0,
      quotaBytes: this.quotaBytes,
      exceeded: false,
      writesRevoked: false,
      checkedAt: null,
    };
  }

  status(): QuotaStatus {
    return { ...this.#status };
  }

  start(): void {
    if (this.#timer !== undefined) {
      return;
    }

    void this.check().catch((error: unknown) => {
      this.#logger.error("plugin.quota_check_failed", { error });
    });
    this.#timer = setInterval(() => {
      void this.check().catch((error: unknown) => {
        this.#logger.error("plugin.quota_check_failed", { error });
      });
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Measures the schema and revokes writes when it is over quota. Safe to call directly. */
  async check(): Promise<QuotaStatus> {
    if (this.#checking !== undefined) {
      return this.#checking;
    }

    this.#checking = this.#runCheck().finally(() => {
      this.#checking = undefined;
    });

    return this.#checking;
  }

  /** Admin action: allow writes again (the next check revokes again if still over quota). */
  async restoreWrites(): Promise<QuotaStatus> {
    const sql = new SQL(this.#adminUrl, { max: 1, connectionTimeout: 5 });

    try {
      await sql.unsafe(`
        GRANT INSERT, UPDATE
          ON ALL TABLES IN SCHEMA ${quote(this.schema)}
          TO ${quote(this.#runtimeRole)}
      `);
      this.#status = { ...this.#status, writesRevoked: false };
      this.#logger.info("plugin.quota_writes_restored", { schema: this.schema });
      return this.status();
    } finally {
      await sql.close().catch(() => undefined);
    }
  }

  async #runCheck(): Promise<QuotaStatus> {
    const sql = new SQL(this.#adminUrl, { max: 1, connectionTimeout: 5 });

    try {
      const rows = (await sql`
        SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint AS bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${this.schema}
          AND c.relkind IN ('r', 'm', 'p', 't')
      `) as Array<{ bytes: number | string }>;
      const usedBytes = Number(rows[0]?.bytes ?? 0);
      const exceeded = usedBytes > this.quotaBytes;
      let writesRevoked = this.#status.writesRevoked;

      if (exceeded && !writesRevoked) {
        await sql.unsafe(`
          REVOKE INSERT, UPDATE
            ON ALL TABLES IN SCHEMA ${quote(this.schema)}
            FROM ${quote(this.#runtimeRole)}
        `);
        await sql`
          INSERT INTO core.system_audit_buffer (action, target_type, target_id, summary)
          VALUES (
            'plugin.quota_exceeded',
            'plugin',
            NULL,
            jsonb_build_object(
              'pluginId', ${this.pluginId}::text,
              'schema', ${this.schema}::text,
              'usedBytes', ${usedBytes}::bigint,
              'quotaBytes', ${this.quotaBytes}::bigint,
              'writesRevoked', true
            )
          )
        `;
        writesRevoked = true;
        this.#logger.error("plugin.storage_quota_exceeded", {
          schema: this.schema,
          usedBytes,
          quotaBytes: this.quotaBytes,
        });
      }

      this.#status = {
        pluginId: this.pluginId,
        schema: this.schema,
        usedBytes,
        quotaBytes: this.quotaBytes,
        exceeded,
        writesRevoked,
        checkedAt: new Date().toISOString(),
      };

      this.#logger.debug("plugin.quota_checked", {
        schema: this.schema,
        usedBytes,
        writesRevoked,
      });
      return this.status();
    } finally {
      await sql.close().catch(() => undefined);
    }
  }
}
