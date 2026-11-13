import type { PluginManifest } from "@bulletin/plugin-sdk/manifest";
import type { SQL } from "bun";
import { queueSystemAudit } from "../audit/index.ts";

/**
 * Plugin lifecycle state machine (ADR 0009). The orchestrator owns the database state and the
 * operation journal; sandbox/provisioning work sits behind {@link PluginRuntime} so the same
 * transitions are used by the real plugin-host and by failure-injection tests.
 *
 *   installing → active → disabled → uninstalled
 *                     ↘ upgrading → active | failed
 *                     ↘ failed (behaves as disabled)
 */

export type PluginState =
  | "installing"
  | "active"
  | "disabled"
  | "upgrading"
  | "failed"
  | "uninstalled";

export interface PluginRecord {
  readonly pluginId: string;
  readonly version: string;
  readonly sdkVersion: string;
  readonly state: PluginState;
  readonly enabled: boolean;
  readonly generation: number;
  readonly capabilities: readonly string[];
  /** Capabilities the admin approved; runtime access is checked against these. */
  readonly approvedCapabilities: readonly string[];
  /** Egress hosts the admin approved; runtime egress is checked against these. */
  readonly approvedEgressHosts: readonly string[];
  readonly error: string | null;
}

export interface PersonalDataDeclaration {
  readonly table: string;
  readonly memberColumn: string;
}

export interface PluginRuntime {
  /** Creates the schema, roles and, where supported, the sandbox before migrations. */
  provision(record: PluginRecord, manifest: PluginManifest): Promise<void>;
  /** Runs the bundle migrations in one transaction as the plugin owner. */
  migrate(record: PluginRecord, manifest: PluginManifest): Promise<void>;
  /** Starts the sandbox and returns whether its health check passed. */
  activate(record: PluginRecord, manifest: PluginManifest): Promise<boolean>;
  /** Stops dispatching hooks/jobs/routes and waits for in-flight calls. */
  quiesce(record: PluginRecord): Promise<void>;
  /** Stops the sandbox after a disable. */
  deactivate(record: PluginRecord): Promise<void>;
  /** Drops the plugin schema after an uninstall that chose not to keep data. */
  drop(record: PluginRecord): Promise<void>;
  /** Starts a maintenance sandbox with only GDPR handlers, used when the plugin is off. */
  maintenance(
    record: PluginRecord,
    operation: "export" | "erase",
    memberId: string,
  ): Promise<GdprResult>;
  /** Export/erase for an active sandbox (hooks and routes exist but GDPR is the same call). */
  gdpr(record: PluginRecord, operation: "export" | "erase", memberId: string): Promise<GdprResult>;
  /** Publishes hook fragments/registry and bumps pluginsGeneration. */
  refreshGeneration(record: PluginRecord, manifest: PluginManifest): Promise<number>;
}

export interface GdprResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export class LifecycleError extends Error {
  readonly code:
    | "step_up"
    | "approval"
    | "checksum"
    | "state"
    | "migration"
    | "activation"
    | "gdpr";

  constructor(code: LifecycleError["code"], message: string) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
  }
}

const STEP_UP_WINDOW_MS = 5 * 60 * 1_000;

function record(row: {
  plugin_id: string;
  version: string;
  sdk_version: string;
  state: PluginState;
  enabled: boolean;
  generation: number;
  capabilities: unknown;
  approved_capabilities?: unknown;
  approved_egress_hosts?: unknown;
  error: string | null;
}): PluginRecord {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

  return {
    pluginId: row.plugin_id,
    version: row.version,
    sdkVersion: row.sdk_version,
    state: row.state,
    enabled: row.enabled,
    generation: row.generation,
    capabilities: strings(row.capabilities),
    approvedCapabilities: strings(row.approved_capabilities),
    approvedEgressHosts: strings(row.approved_egress_hosts),
    error: row.error,
  };
}

export async function loadPlugin(sql: SQL, pluginId: string): Promise<PluginRecord | null> {
  const rows = (await sql`
    SELECT plugin_id, version, sdk_version, state, enabled, generation, capabilities,
           approved_capabilities, approved_egress_hosts, error
    FROM core.plugins
    WHERE plugin_id = ${pluginId}
  `) as Array<Parameters<typeof record>[0]>;

  return rows[0] === undefined ? null : record(rows[0]);
}

async function setState(
  sql: SQL,
  pluginId: string,
  state: PluginState,
  options: {
    readonly enabled?: boolean;
    readonly version?: string;
    readonly error?: string | null;
    readonly signature?: string;
    readonly checksum?: string;
    readonly bundle?: Uint8Array;
  } = {},
): Promise<void> {
  await sql`
    UPDATE core.plugins
    SET state = ${state},
        enabled = ${options.enabled ?? false},
        version = coalesce(${options.version ?? null}::text, version),
        error = ${options.error ?? null},
        signature = coalesce(${options.signature ?? null}::text, signature),
        checksum = coalesce(${options.checksum ?? null}::text, checksum),
        bundle = coalesce(
          ${options.bundle === undefined ? null : Buffer.from(options.bundle)}::bytea,
          bundle
        ),
        updated_at = now()
    WHERE plugin_id = ${pluginId}
  `;
}

async function journal(
  sql: SQL,
  pluginId: string,
  kind: "install" | "upgrade" | "uninstall",
  step: string,
  state: "running" | "completed" | "failed",
  error?: string,
  targetVersion?: string,
): Promise<void> {
  await sql`
    INSERT INTO core.plugin_operations (plugin_id, kind, step, state, error, target_version)
    VALUES (${pluginId}, ${kind}, ${step}, ${state}, ${error ?? null}, ${targetVersion ?? null})
  `;
}

export interface InstallInput {
  readonly manifest: PluginManifest;
  readonly bundle: Uint8Array;
  readonly checksum: string;
  readonly signature: string;
  readonly approved: boolean;
  /** When the admin completed step-up authentication. */
  readonly stepUpAt: Date | null;
  readonly actorId: string;
  readonly now?: Date;
}

export interface LifecycleOptions {
  readonly sql: SQL;
  readonly runtime: PluginRuntime;
  readonly now?: () => Date;
}

/**
 * Egress hosts without the egress capability would let a manifest reach the network through
 * the broker while asking the admin to approve nothing that mentions it. Reject at install
 * and upgrade as well as at manifest parse time.
 */
function assertApprovableManifest(manifest: PluginManifest): void {
  if (manifest.egressHosts.length > 0 && !manifest.capabilities.includes("egress")) {
    throw new LifecycleError(
      "approval",
      "Egress hosts require the egress capability to be approved",
    );
  }
}

export class PluginLifecycle {
  readonly #sql: SQL;
  readonly #runtime: PluginRuntime;
  readonly #now: () => Date;

  constructor(options: LifecycleOptions) {
    this.#sql = options.sql;
    this.#runtime = options.runtime;
    this.#now = options.now ?? (() => new Date());
  }

  /** Installs a verified bundle. Approval and recent step-up are mandatory (ADR 0009). */
  async install(input: InstallInput): Promise<PluginRecord> {
    if (!input.approved) {
      throw new LifecycleError("approval", "Capabilities were not approved");
    }

    assertApprovableManifest(input.manifest);

    const now = input.now ?? this.#now();
    const stepUpAge =
      input.stepUpAt === null ? Number.POSITIVE_INFINITY : now.getTime() - input.stepUpAt.getTime();

    if (stepUpAge > STEP_UP_WINDOW_MS || stepUpAge < 0) {
      throw new LifecycleError("step_up", "Recent authentication is required to install a plugin");
    }

    const existing = await loadPlugin(this.#sql, input.manifest.id);

    if (existing !== null && existing.state !== "uninstalled" && existing.state !== "failed") {
      throw new LifecycleError("state", `Plugin ${input.manifest.id} is already installed`);
    }

    const personalData = input.manifest.personalData.map((entry) => ({
      table: entry.table,
      memberColumn: entry.memberColumn,
    }));

    await this.#sql`
      INSERT INTO core.plugins (
        plugin_id, version, sdk_version, state, enabled, capabilities,
        approved_capabilities, approved_egress_hosts, personal_data,
        bundle, signature, checksum
      ) VALUES (
        ${input.manifest.id}, ${input.manifest.version}, ${input.manifest.sdkVersion},
        'installing', false, (${JSON.stringify(input.manifest.capabilities)}::text)::jsonb,
        (${JSON.stringify(input.manifest.capabilities)}::text)::jsonb,
        (${JSON.stringify(input.manifest.egressHosts)}::text)::jsonb,
        (${JSON.stringify(personalData)}::text)::jsonb, ${Buffer.from(input.bundle)},
        ${input.signature}, ${input.checksum}
      )
      ON CONFLICT (plugin_id) DO UPDATE SET
        version = EXCLUDED.version,
        sdk_version = EXCLUDED.sdk_version,
        state = 'installing',
        enabled = false,
        capabilities = EXCLUDED.capabilities,
        approved_capabilities = EXCLUDED.approved_capabilities,
        approved_egress_hosts = EXCLUDED.approved_egress_hosts,
        personal_data = EXCLUDED.personal_data,
        bundle = EXCLUDED.bundle,
        signature = EXCLUDED.signature,
        checksum = EXCLUDED.checksum,
        error = NULL,
        updated_at = now()
    `;

    const installing = await loadPlugin(this.#sql, input.manifest.id);

    if (installing === null) {
      throw new LifecycleError("state", "Plugin row disappeared during install");
    }

    try {
      await journal(this.#sql, installing.pluginId, "install", "provision", "running");
      await this.#runtime.provision(installing, input.manifest);
      await journal(this.#sql, installing.pluginId, "install", "provision", "completed");

      await journal(this.#sql, installing.pluginId, "install", "migrate", "running");
      await this.#runtime.migrate(installing, input.manifest);
      await journal(this.#sql, installing.pluginId, "install", "migrate", "completed");

      await journal(this.#sql, installing.pluginId, "install", "activate", "running");
      const healthy = await this.#runtime.activate(installing, input.manifest);

      if (!healthy) {
        await setState(this.#sql, installing.pluginId, "failed", {
          error: "The plugin failed its health check",
          version: input.manifest.version,
        });
        await journal(
          this.#sql,
          installing.pluginId,
          "install",
          "activate",
          "failed",
          "health check failed",
        );
        await this.#audit(installing.pluginId, "plugin.install_failed", {
          version: input.manifest.version,
        });
        throw new LifecycleError("activation", "The plugin failed its health check");
      }

      await journal(this.#sql, installing.pluginId, "install", "activate", "completed");

      for (const declaration of personalData) {
        await this.#sql`
          INSERT INTO core.plugin_personal_data (plugin_id, table_name, member_column)
          VALUES (${installing.pluginId}, ${declaration.table}, ${declaration.memberColumn})
          ON CONFLICT DO NOTHING
        `;
      }

      const generation = await this.#runtime.refreshGeneration(installing, input.manifest);
      await setState(this.#sql, installing.pluginId, "active", {
        enabled: true,
        version: input.manifest.version,
      });
      await this.#sql`
        UPDATE core.plugins SET generation = ${generation}, updated_at = now()
        WHERE plugin_id = ${installing.pluginId}
      `;
      await this.#audit(installing.pluginId, "plugin.installed", {
        version: input.manifest.version,
        capabilities: input.manifest.capabilities,
      });

      return (await loadPlugin(this.#sql, installing.pluginId)) as PluginRecord;
    } catch (error) {
      if (error instanceof LifecycleError) {
        throw error;
      }

      await setState(this.#sql, installing.pluginId, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await journal(
        this.#sql,
        installing.pluginId,
        "install",
        "failed",
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /** Quiesce, migrate in one transaction, activate; a failed activation leaves it failed. */
  async upgrade(pluginId: string, input: InstallInput): Promise<PluginRecord> {
    const current = await loadPlugin(this.#sql, pluginId);

    if (current === null || current.state !== "active") {
      throw new LifecycleError("state", "Only an active plugin can be upgraded");
    }

    if (input.manifest.id !== pluginId) {
      throw new LifecycleError("state", "Bundle id does not match the installed plugin");
    }

    if (!input.approved) {
      throw new LifecycleError("approval", "Capabilities were not approved");
    }

    assertApprovableManifest(input.manifest);

    await setState(this.#sql, pluginId, "upgrading", { enabled: false });
    await journal(
      this.#sql,
      pluginId,
      "upgrade",
      "quiesce",
      "running",
      undefined,
      input.manifest.version,
    );
    await this.#runtime.quiesce(current);
    await journal(
      this.#sql,
      pluginId,
      "upgrade",
      "quiesce",
      "completed",
      undefined,
      input.manifest.version,
    );

    const upgrading: PluginRecord = {
      ...current,
      state: "upgrading",
      enabled: false,
      version: input.manifest.version,
    };

    try {
      await journal(
        this.#sql,
        pluginId,
        "upgrade",
        "migrate",
        "running",
        undefined,
        input.manifest.version,
      );
      await this.#runtime.migrate(upgrading, input.manifest);
      await journal(
        this.#sql,
        pluginId,
        "upgrade",
        "migrate",
        "completed",
        undefined,
        input.manifest.version,
      );
    } catch (error) {
      // The migration transaction rolled back; restore the old code and version.
      await this.#runtime.activate(current, input.manifest);
      await setState(this.#sql, pluginId, "active", { enabled: true });
      await journal(
        this.#sql,
        pluginId,
        "upgrade",
        "migrate",
        "failed",
        error instanceof Error ? error.message : String(error),
        input.manifest.version,
      );
      throw new LifecycleError(
        "migration",
        `Upgrade migration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const healthy = await this.#runtime.activate(upgrading, input.manifest);

    if (!healthy) {
      await setState(this.#sql, pluginId, "failed", {
        error: "The new version failed its health check",
        version: input.manifest.version,
      });
      await journal(
        this.#sql,
        pluginId,
        "upgrade",
        "activate",
        "failed",
        "health check failed",
        input.manifest.version,
      );
      await this.#audit(pluginId, "plugin.upgrade_failed", {
        version: input.manifest.version,
      });
      throw new LifecycleError("activation", "The new version failed its health check");
    }

    const generation = await this.#runtime.refreshGeneration(upgrading, input.manifest);
    await journal(
      this.#sql,
      pluginId,
      "upgrade",
      "activate",
      "completed",
      undefined,
      input.manifest.version,
    );
    await setState(this.#sql, pluginId, "active", {
      enabled: true,
      version: input.manifest.version,
    });
    await this.#sql`
      UPDATE core.plugins SET generation = ${generation}, updated_at = now()
      WHERE plugin_id = ${pluginId}
    `;
    await this.#setApprovedGrants(pluginId, input.manifest);
    await this.#audit(pluginId, "plugin.upgraded", {
      from: current.version,
      to: input.manifest.version,
    });

    return (await loadPlugin(this.#sql, pluginId)) as PluginRecord;
  }

  /** Disables a plugin immediately and bumps the generation so caches miss. */
  async disable(pluginId: string, reason = "disabled by an admin"): Promise<PluginRecord> {
    const current = await loadPlugin(this.#sql, pluginId);

    if (current === null) {
      throw new LifecycleError("state", "Plugin is not installed");
    }

    if (current.state === "disabled" || current.state === "uninstalled") {
      return current;
    }

    await setState(this.#sql, pluginId, "disabled", { enabled: false });
    await this.#runtime.deactivate(current);
    const generation = await this.#nextGeneration();
    await this.#sql`
      UPDATE core.plugins SET generation = ${generation}, updated_at = now()
      WHERE plugin_id = ${pluginId}
    `;
    await this.#audit(pluginId, "plugin.disabled", { reason });
    return (await loadPlugin(this.#sql, pluginId)) as PluginRecord;
  }

  /** Disables, optionally runs GDPR hooks, optionally drops the schema, removes registry rows. */
  async uninstall(
    pluginId: string,
    options: {
      readonly dataAction: "keep" | "drop" | "erase";
      readonly actorId: string;
    },
  ): Promise<void> {
    const current = await loadPlugin(this.#sql, pluginId);

    if (current === null) {
      return;
    }

    await this.disable(pluginId, "uninstall");
    await journal(this.#sql, pluginId, "uninstall", "disable", "completed");

    if (options.dataAction === "erase") {
      const result = await this.#runtime.maintenance(current, "erase", "");
      await journal(
        this.#sql,
        pluginId,
        "uninstall",
        "erase",
        result.ok ? "completed" : "failed",
        result.error,
      );

      if (!result.ok) {
        throw new LifecycleError("gdpr", "The plugin's erasure handler did not complete");
      }
    }

    if (options.dataAction === "drop") {
      await this.#runtime.drop(current);
      await journal(this.#sql, pluginId, "uninstall", "drop_schema", "completed");
    }

    await this.#sql`DELETE FROM core.plugin_registry WHERE plugin_id = ${pluginId}`;
    await this.#sql`DELETE FROM core.plugin_settings WHERE plugin_id = ${pluginId}`;
    await this.#sql`DELETE FROM core.plugin_jobs WHERE plugin_id = ${pluginId}`;
    await this.#sql`DELETE FROM core.plugin_event_subscriptions WHERE plugin_id = ${pluginId}`;
    await this.#sql`
      UPDATE core.plugins
      SET state = 'uninstalled', enabled = false, updated_at = now()
      WHERE plugin_id = ${pluginId}
    `;
    const generation = await this.#nextGeneration();
    await this.#sql`
      UPDATE core.plugins SET generation = ${generation}, updated_at = now()
      WHERE plugin_id = ${pluginId}
    `;
    // Personal-data declarations stay behind: retained data must remain discoverable.
    await this.#audit(pluginId, "plugin.uninstalled", {
      dataAction: options.dataAction,
      actorId: options.actorId,
    });
  }

  /** GDPR export/erasure for an active plugin or a maintenance sandbox when it is not running. */
  async gdpr(
    pluginId: string,
    operation: "export" | "erase",
    memberId: string,
  ): Promise<GdprResult> {
    const current = await loadPlugin(this.#sql, pluginId);

    if (current === null) {
      return { ok: false, error: "Plugin is not installed" };
    }

    const declarations = (await this.#sql`
      SELECT table_name, member_column FROM core.plugin_personal_data
      WHERE plugin_id = ${pluginId}
    `) as Array<{ table_name: string; member_column: string }>;

    if (declarations.length === 0) {
      return { ok: true, data: {} };
    }

    const rows = (await this.#sql`
      INSERT INTO core.plugin_gdpr_requests (plugin_id, kind, member_id, status)
      VALUES (${pluginId}, ${operation}, ${memberId}, 'open')
      RETURNING id
    `) as Array<{ id: bigint | string }>;
    const requestId = rows[0]?.id;

    const result =
      current.enabled && current.state === "active"
        ? await this.#runtime.gdpr(current, operation, memberId)
        : await this.#runtime.maintenance(current, operation, memberId);

    if (!result.ok) {
      if (requestId !== undefined) {
        await this.#sql`
          UPDATE core.plugin_gdpr_requests
          SET status = 'failed', error = ${result.error ?? "handler failed"}
          WHERE id = ${requestId}
        `;
      }

      // The request stays open: completing it while retained data is unprocessed would lie.
      return result;
    }

    if (requestId !== undefined) {
      await this.#sql`
        UPDATE core.plugin_gdpr_requests
        SET status = 'completed', completed_at = now()
        WHERE id = ${requestId}
      `;
    }

    return result;
  }

  /** Resumes an interrupted upgrade from the last journaled step. */
  async resume(pluginId: string, manifest: PluginManifest): Promise<PluginRecord> {
    const current = await loadPlugin(this.#sql, pluginId);

    if (current === null) {
      throw new LifecycleError("state", "Plugin is not installed");
    }

    assertApprovableManifest(manifest);

    const targetRows = (await this.#sql`
      SELECT target_version FROM core.plugin_operations
      WHERE plugin_id = ${pluginId} AND kind = 'upgrade' AND target_version IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `) as Array<{ target_version: string }>;
    const targetVersion = targetRows[0]?.target_version ?? manifest.version;
    const steps = (await this.#sql`
      SELECT step FROM core.plugin_operations
      WHERE plugin_id = ${pluginId} AND kind = 'upgrade' AND state = 'completed'
        AND target_version = ${targetVersion}
      ORDER BY id DESC
    `) as Array<{ step: string }>;
    const done = new Set(steps.map((step) => step.step));

    if (current.state !== "upgrading") {
      return current;
    }

    if (targetVersion !== manifest.version) {
      // The journal belongs to an older target; restart the new upgrade at migration time.
      done.clear();
    }

    if (!done.has("migrate")) {
      await this.#runtime.migrate(current, manifest);
      await journal(
        this.#sql,
        pluginId,
        "upgrade",
        "migrate",
        "completed",
        undefined,
        manifest.version,
      );
    }

    const healthy = await this.#runtime.activate(current, manifest);

    if (!healthy) {
      await setState(this.#sql, pluginId, "failed", {
        error: "The new version failed its health check",
        version: manifest.version,
      });
      await this.#audit(pluginId, "plugin.upgrade_failed", { version: manifest.version });
      throw new LifecycleError("activation", "The new version failed its health check");
    }

    const generation = await this.#runtime.refreshGeneration(current, manifest);
    await setState(this.#sql, pluginId, "active", { enabled: true, version: manifest.version });
    await this.#sql`
      UPDATE core.plugins SET generation = ${generation}, updated_at = now()
      WHERE plugin_id = ${pluginId}
    `;
    await this.#setApprovedGrants(pluginId, manifest);
    await journal(
      this.#sql,
      pluginId,
      "upgrade",
      "activate",
      "completed",
      undefined,
      manifest.version,
    );
    return (await loadPlugin(this.#sql, pluginId)) as PluginRecord;
  }

  async #setApprovedGrants(pluginId: string, manifest: PluginManifest): Promise<void> {
    await this.#sql`
      UPDATE core.plugins
      SET capabilities = (${JSON.stringify(manifest.capabilities)}::text)::jsonb,
          approved_capabilities = (${JSON.stringify(manifest.capabilities)}::text)::jsonb,
          approved_egress_hosts = (${JSON.stringify(manifest.egressHosts)}::text)::jsonb,
          updated_at = now()
      WHERE plugin_id = ${pluginId}
    `;
  }

  async #nextGeneration(): Promise<number> {
    const rows = (await this.#sql`
      UPDATE core.plugin_generation
      SET generation = generation + 1, updated_at = now()
      WHERE id = true
      RETURNING generation
    `) as Array<{ generation: number }>;

    return rows[0]?.generation ?? 1;
  }

  async #audit(pluginId: string, action: string, summary: Record<string, unknown>): Promise<void> {
    await queueSystemAudit(this.#sql, {
      action,
      targetType: "plugin",
      summary: { pluginId, ...summary },
    });
  }
}
