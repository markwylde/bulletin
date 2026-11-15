import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "@bulletin/config";
import { queueSystemAudit } from "@bulletin/domain/audit";
import {
  advancePluginsGeneration,
  fetchMarketplacePlugin,
  unpackPluginBundle,
} from "@bulletin/domain/plugins";
import type { PluginManifest } from "@bulletin/plugin-sdk/manifest";
import { opaqueKey, type StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import { Broker, type PluginGrantsLoader } from "../broker/broker.ts";
import type { CacheInvalidator } from "../broker/cache.ts";
import { BrokerChannel } from "../broker/channel.ts";
import type { PluginConnectionManager } from "../broker/connections.ts";
import type { CoreApiClient } from "../broker/core.ts";
import { PluginDatabase } from "../broker/database.ts";
import { EgressProxy } from "../broker/egress.ts";
import { loadPluginManifest, loadPluginMigrations } from "../broker/manifest.ts";
import { publishPluginFragments, publishPluginRegistry } from "../hooks/publish.ts";
import type { PluginHookRegistry } from "../hooks/registry.ts";
import { PluginQuotaMonitor } from "../quota/monitor.ts";
import type { SandboxSupervisor } from "../sandbox/supervisor.ts";

/**
 * Runs every installed and enabled plugin, each in its own sandbox with its own broker,
 * database namespace and egress allow-list (ADR 0009). `core.plugins` is the durable desired
 * state; a `bulletin_plugins` NOTIFY or the periodic sweep only triggers {@link reconcile}
 * (ADR 0003), so a missed notification delays a change but never loses it.
 */

export interface RunningPlugin {
  readonly manifest: PluginManifest;
  readonly bundlePath: string;
  readonly checksum: string;
  readonly database: PluginDatabase;
  readonly broker: Broker;
  readonly channel: BrokerChannel;
  readonly supervisor: SandboxSupervisor;
  readonly quota: PluginQuotaMonitor;
}

export interface SupervisorFactoryOptions {
  readonly pluginId: string;
  readonly bundlePath: string;
  readonly channel: BrokerChannel;
  /** A one-shot maintenance sandbox has no restart policy and a short lifetime. */
  readonly maintenance: boolean;
}

export interface PluginManagerOptions {
  /** Control-plane connection (owner role) for `core.plugins` and fragment publishing. */
  readonly sql: SQL;
  readonly logger: Logger;
  readonly stateDir: string;
  readonly pluginDatabaseUrl: string;
  readonly connections: PluginConnectionManager;
  readonly core: CoreApiClient;
  readonly cache: CacheInvalidator;
  readonly nodeEnv: "development" | "test" | "production";
  readonly isActive: (pluginId: string) => Promise<boolean>;
  readonly grants: PluginGrantsLoader;
  readonly hooks: PluginHookRegistry;
  /** Live maps shared with the internal HTTP API and the client-app server. */
  readonly transports: Map<string, BrokerChannel>;
  readonly bundles: Map<string, { manifest: PluginManifest; path: string }>;
  readonly createSupervisor: (options: SupervisorFactoryOptions) => SandboxSupervisor;
  readonly quota: { readonly quotaBytes: number; readonly intervalMs: number };
  /** Object storage holding installed bundles under `core.plugins.bundle_key`. */
  readonly storage?: StorageClient;
  /** Verified marketplace for rows that have no stored bundle (the dev seed's samples). */
  readonly marketplaceUrl?: string;
  /** A bundle on disk that runs without a marketplace install (the local demo plugin). */
  readonly localBundlePath?: string;
}

interface PluginRow {
  readonly plugin_id: string;
  readonly state: string;
  readonly enabled: boolean;
  readonly checksum: string | null;
}

const LOCAL_CHECKSUM = "local";

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function wanted(row: PluginRow | undefined): boolean {
  return row?.enabled === true && (row.state === "installing" || row.state === "active");
}

export class PluginManager {
  readonly #options: PluginManagerOptions;
  readonly #logger: Logger;
  readonly #running = new Map<string, RunningPlugin>();
  #localManifest: PluginManifest | undefined;
  #queue: Promise<void> = Promise.resolve();
  #pending = false;
  #closed = false;

  constructor(options: PluginManagerOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: "plugins" });
  }

  get localPluginId(): string | undefined {
    return this.#localManifest?.id;
  }

  running(): ReadonlyMap<string, RunningPlugin> {
    return this.#running;
  }

  get(pluginId: string): RunningPlugin | undefined {
    return this.#running.get(pluginId);
  }

  /** Loads the local bundle's manifest and makes sure it has a `core.plugins` row. */
  async init(): Promise<void> {
    if (this.#options.localBundlePath === undefined) {
      return;
    }

    this.#localManifest = await loadPluginManifest(this.#options.localBundlePath);
    // The local demo plugin is visible in the staff manager without a marketplace install.
    await publishPluginRegistry(this.#options.sql, this.#localManifest, this.#logger);
  }

  /**
   * Brings running sandboxes in line with `core.plugins`. Calls are serialised; a call made
   * while one is running schedules exactly one more pass, which reads the latest rows.
   */
  reconcile(): Promise<void> {
    if (this.#pending) {
      return this.#queue;
    }

    this.#pending = true;
    this.#queue = this.#queue
      .then(async () => {
        this.#pending = false;

        if (!this.#closed) {
          await this.#reconcileOnce();
        }
      })
      .catch((error: unknown) => {
        this.#logger.error("plugin.reconcile_failed", { error });
      });
    return this.#queue;
  }

  async #reconcileOnce(): Promise<void> {
    const rows = (await this.#options.sql`
      SELECT plugin_id, state, enabled, checksum FROM core.plugins
    `) as PluginRow[];
    const byId = new Map(rows.map((row) => [row.plugin_id, row]));

    for (const [pluginId, running] of this.#running) {
      const row = byId.get(pluginId);
      const local = pluginId === this.#localManifest?.id;
      const changed = !local && row?.checksum !== null && row?.checksum !== running.checksum;

      if (!wanted(row) || changed) {
        await this.#stop(pluginId, changed ? "bundle changed" : (row?.state ?? "removed"));
      }
    }

    for (const row of rows) {
      if (wanted(row) && !this.#running.has(row.plugin_id)) {
        await this.#start(row);
      }
    }
  }

  async #start(row: PluginRow): Promise<void> {
    const pluginId = row.plugin_id;
    const installing = row.state === "installing";
    let started: Partial<RunningPlugin> = {};

    try {
      if (installing) {
        await this.#journal(pluginId, "activate", "running");
      }

      const bundle = await this.#materialize(pluginId);

      if (bundle === null) {
        return;
      }

      const migrations = await loadPluginMigrations(bundle.path, bundle.manifest);
      const database = await PluginDatabase.open({
        adminUrl: this.#options.pluginDatabaseUrl,
        pluginId,
        migrations,
        logger: this.#logger,
        connections: this.#options.connections,
      });
      started = { database };
      const broker = this.#broker(database, bundle.manifest);
      started = { ...started, broker };
      const channel = new BrokerChannel({
        socketPath: join(this.#options.stateDir, "sockets", `${pluginId}.sock`),
        logger: this.#logger,
        handler: broker,
        expectedPluginId: pluginId,
      });
      await channel.start();
      started = { ...started, channel };
      const supervisor = this.#options.createSupervisor({
        pluginId,
        bundlePath: bundle.path,
        channel,
        maintenance: false,
      });
      started = { ...started, supervisor };
      await supervisor.start();

      const quota = new PluginQuotaMonitor({
        adminUrl: this.#options.pluginDatabaseUrl,
        pluginId,
        logger: this.#logger.child({ component: "quota" }),
        quotaBytes: this.#options.quota.quotaBytes,
        intervalMs: this.#options.quota.intervalMs,
      });
      quota.start();

      const running: RunningPlugin = {
        manifest: bundle.manifest,
        bundlePath: bundle.path,
        checksum: bundle.checksum,
        database,
        broker,
        channel,
        supervisor,
        quota,
      };
      this.#running.set(pluginId, running);
      this.#options.transports.set(pluginId, channel);
      this.#options.bundles.set(pluginId, { manifest: bundle.manifest, path: bundle.path });

      const published = await publishPluginFragments(
        this.#options.sql,
        bundle.manifest,
        this.#logger,
      );
      await publishPluginRegistry(this.#options.sql, bundle.manifest, this.#logger);
      // An install or enable always starts a new pluginsGeneration, so compiled templates and
      // cached pages miss even when the fragments joined the current one (ADR 0006, 0009).
      const generation = installing
        ? await advancePluginsGeneration(this.#options.sql)
        : published.generation;
      this.#options.hooks.install(bundle.manifest, { generation });

      const activated = (await this.#options.sql`
        UPDATE core.plugins
        SET state = 'active', enabled = true, error = NULL, last_error = NULL,
            version = ${bundle.manifest.version}, name = coalesce(name, ${bundle.manifest.name}),
            generation = ${generation}, updated_at = now()
        WHERE plugin_id = ${pluginId} AND enabled AND state IN ('installing', 'active')
        RETURNING plugin_id
      `) as unknown[];

      if (activated.length === 0) {
        // Disabled or uninstalled while it was starting: the next pass stops it.
        void this.reconcile();
        return;
      }

      if (installing) {
        await this.#journal(pluginId, "activate", "completed");
        await queueSystemAudit(this.#options.sql, {
          action: "plugin.installed",
          targetType: "plugin",
          summary: { pluginId, version: bundle.manifest.version },
        });
      }

      this.#logger.info("plugin.started", {
        pluginId,
        version: bundle.manifest.version,
        generation,
      });
    } catch (error) {
      this.#logger.error("plugin.start_failed", { pluginId, error });
      this.#running.delete(pluginId);
      this.#options.transports.delete(pluginId);
      this.#options.bundles.delete(pluginId);
      this.#options.hooks.remove(pluginId);
      await this.#teardown(started);
      await this.#fail(pluginId, errorMessage(error), installing);
    }
  }

  async #stop(pluginId: string, reason: string): Promise<void> {
    const running = this.#running.get(pluginId);

    this.#running.delete(pluginId);
    this.#options.transports.delete(pluginId);
    this.#options.bundles.delete(pluginId);
    this.#options.hooks.remove(pluginId);

    if (running !== undefined) {
      await this.#teardown(running);
      this.#logger.info("plugin.stopped", { pluginId, reason });
    }
  }

  async #teardown(parts: Partial<RunningPlugin>): Promise<void> {
    parts.quota?.stop();
    await parts.supervisor?.stop().catch(() => undefined);
    await parts.channel?.close().catch(() => undefined);

    if (parts.broker !== undefined) {
      await parts.broker.close().catch(() => undefined);
    } else {
      await parts.database?.close().catch(() => undefined);
    }
  }

  async #fail(pluginId: string, message: string, installing: boolean): Promise<void> {
    try {
      await this.#options.sql`
        UPDATE core.plugins
        SET state = 'failed', enabled = false, error = ${message}, last_error = ${message},
            updated_at = now()
        WHERE plugin_id = ${pluginId}
      `;
      await this.#journal(pluginId, installing ? "activate" : "start", "failed", message);
    } catch (error) {
      this.#logger.error("plugin.fail_record_failed", { pluginId, error });
    }
  }

  async #journal(
    pluginId: string,
    step: string,
    state: "running" | "completed" | "failed",
    error?: string,
  ): Promise<void> {
    await this.#options.sql`
      INSERT INTO core.plugin_operations (plugin_id, kind, step, state, error)
      VALUES (${pluginId}, 'install', ${step}, ${state}, ${error ?? null})
    `;
  }

  #broker(database: PluginDatabase, manifest: PluginManifest): Broker {
    return new Broker({
      database,
      egress: new EgressProxy({
        allowedHosts: manifest.egressHosts,
        logger: this.#logger.child({ component: "egress", pluginId: manifest.id }),
        nodeEnv: this.#options.nodeEnv,
      }),
      core: this.#options.core,
      cache: this.#options.cache,
      logger: this.#logger,
      isActive: this.#options.isActive,
      grants: this.#options.grants,
    });
  }

  /**
   * Puts the plugin's verified bundle on disk. The local bundle runs from its directory; an
   * installed one comes from `core.plugins.bundle`, checked against its stored sha256. A seeded
   * row without a bundle is fetched from the signed marketplace once and stored.
   */
  async #materialize(
    pluginId: string,
  ): Promise<{ manifest: PluginManifest; path: string; checksum: string } | null> {
    if (pluginId === this.#localManifest?.id && this.#options.localBundlePath !== undefined) {
      return {
        manifest: this.#localManifest,
        path: this.#options.localBundlePath,
        checksum: LOCAL_CHECKSUM,
      };
    }

    const rows = (await this.#options.sql`
      SELECT bundle, bundle_key, checksum FROM core.plugins WHERE plugin_id = ${pluginId}
    `) as Array<{ bundle: Uint8Array | null; bundle_key: string | null; checksum: string | null }>;
    const row = rows[0];
    let checksum = row?.checksum ?? null;
    let bytes: Uint8Array | null = row?.bundle ?? null;

    if (bytes === null && row?.bundle_key !== null && row?.bundle_key !== undefined) {
      if (this.#options.storage === undefined) {
        throw new Error("Object storage is not configured");
      }

      bytes = await this.#options.storage.get(row.bundle_key);
    }

    if (bytes === null) {
      if (this.#options.marketplaceUrl === undefined) {
        this.#logger.warn("plugin.bundle_missing", { pluginId });
        return null;
      }

      try {
        const fetched = await fetchMarketplacePlugin({
          baseUrl: this.#options.marketplaceUrl,
          pluginId,
        });
        bytes = fetched.verified.bundle;
        checksum = fetched.verified.checksum;

        if (this.#options.storage !== undefined) {
          const key = opaqueKey("plugin");
          await this.#options.storage.put(key, bytes, { contentType: "application/x-tar" });
          await this.#options.sql`
            UPDATE core.plugins
            SET bundle_key = ${key}, checksum = ${checksum},
                signature = ${fetched.verified.signature}, updated_at = now()
            WHERE plugin_id = ${pluginId} AND bundle IS NULL AND bundle_key IS NULL
          `;
        }
      } catch (error) {
        // The marketplace may still be starting; the periodic sweep retries.
        this.#logger.warn("plugin.bundle_fetch_failed", { pluginId, error });
        return null;
      }
    }

    const digest = createHash("sha256").update(bytes).digest("hex");

    if (checksum === null || digest !== checksum) {
      throw new Error("The stored bundle does not match its checksum");
    }

    const { manifest, files } = unpackPluginBundle(new Uint8Array(bytes));

    if (manifest.id !== pluginId) {
      throw new Error(`The bundle is for ${manifest.id}, not ${pluginId}`);
    }

    const path = join(this.#options.stateDir, "bundles", pluginId, digest.slice(0, 16));
    await rm(path, { recursive: true, force: true });

    for (const [name, data] of files) {
      const file = join(path, name);
      // Every directory and file must be readable by the per-plugin sandbox UID.
      await mkdir(dirname(file), { recursive: true, mode: 0o755 });
      await writeFile(file, data, { mode: 0o644 });
    }

    await chmod(path, 0o755);
    return { manifest, path, checksum: digest };
  }

  /** GDPR export/erase for a plugin with no running sandbox: a one-shot maintenance jail. */
  async maintenanceGdpr(
    pluginId: string,
    operation: "export" | "erase",
    memberId: string,
  ): Promise<{ readonly ok: boolean; readonly data?: unknown; readonly error?: string }> {
    let parts: Partial<RunningPlugin> = {};

    try {
      const bundle = await this.#materialize(pluginId);

      if (bundle === null) {
        return { ok: false, error: "plugin bundle is not available" };
      }

      const database = await PluginDatabase.open({
        adminUrl: this.#options.pluginDatabaseUrl,
        pluginId,
        migrations: await loadPluginMigrations(bundle.path, bundle.manifest),
        logger: this.#logger,
        connections: this.#options.connections,
      });
      parts = { database };
      const broker = this.#broker(database, bundle.manifest);
      parts = { ...parts, broker };
      const channel = new BrokerChannel({
        socketPath: join(
          this.#options.stateDir,
          "sockets",
          `maintenance-${pluginId}-${randomUUID()}.sock`,
        ),
        logger: this.#logger.child({ component: "maintenance-gdpr" }),
        handler: broker,
        expectedPluginId: pluginId,
      });
      await channel.start();
      parts = { ...parts, channel };
      const supervisor = this.#options.createSupervisor({
        pluginId,
        bundlePath: bundle.path,
        channel,
        maintenance: true,
      });
      parts = { ...parts, supervisor };
      await supervisor.start();
      const data = await channel.request(
        operation === "export" ? "gdpr.export" : "gdpr.erase",
        { memberId },
        30_000,
      );
      return { ok: true, data };
    } catch (error) {
      this.#logger.warn("plugin.maintenance_gdpr_failed", { pluginId, operation, error });
      return { ok: false, error: "maintenance handler failed" };
    } finally {
      await this.#teardown(parts);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;

    for (const pluginId of [...this.#running.keys()]) {
      await this.#stop(pluginId, "shutdown");
    }
  }
}
