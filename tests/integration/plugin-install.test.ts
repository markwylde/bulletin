import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { createLogger } from "@bulletin/config";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import type { SessionRecord } from "@bulletin/domain/auth";
import { PLUGINS_NOTIFY_CHANNEL } from "@bulletin/domain/plugins";
import { createServerT } from "@bulletin/i18n";
import type { StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { CacheInvalidator } from "../../apps/plugin-host/src/broker/cache.ts";
import type { BrokerChannel } from "../../apps/plugin-host/src/broker/channel.ts";
import { PluginConnectionManager } from "../../apps/plugin-host/src/broker/connections.ts";
import { CoreApiClient } from "../../apps/plugin-host/src/broker/core.ts";
import { PluginHookRegistry } from "../../apps/plugin-host/src/hooks/registry.ts";
import { PluginManager } from "../../apps/plugin-host/src/runtime/manager.ts";
import type { SandboxSupervisor } from "../../apps/plugin-host/src/sandbox/supervisor.ts";
import { authorizeStaffRoute, STAFF_ROUTES } from "../../apps/staff-api/src/api.ts";
import {
  disablePlugin,
  enablePlugin,
  requestPluginInstall,
  reviewMarketplacePlugin,
  uninstallPlugin,
} from "../../apps/staff-api/src/plugin-manager.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderDemoRoute } from "../../apps/user-app/src/demo/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import {
  type Catalog,
  createMarketplaceHandler,
  signCatalog,
} from "../../mocks/marketplace/src/app.ts";
import { buildPluginPackages } from "../../mocks/marketplace/src/packages.ts";

// A staff marketplace install, end to end without the jail: staff-api verifies and stores the
// bundle, plugin-host's manager reconciles it into a running plugin with its own broker channel,
// and the demo route renders the plugin's slot (ADR 0009). The sandbox is the compiled bundle
// run by Bun directly; the nsjail boundary itself is covered by the malicious-plugin suite.

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });
const logger = createLogger({ service: "plugin-install-test", level: "error", sink: () => {} });
const PLUGIN = "topic-notice";
const NOTICE = 'data-plugin-notice="topic-notice"';

function memoryStorage(): StorageClient & { readonly objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();

  return {
    objects,
    async put(key, data) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      objects.set(key, new Uint8Array(bytes));
      return bytes.byteLength;
    },
    async get(key) {
      const value = objects.get(key);

      if (value === undefined) {
        throw new Error(`No object ${key}`);
      }

      return value;
    },
    async exists(key) {
      return objects.has(key);
    },
    async stat(key) {
      return { size: objects.get(key)?.byteLength ?? 0, contentType: "", etag: "" };
    },
    async delete(key) {
      objects.delete(key);
    },
    async copy(source, destination) {
      const value = objects.get(source);

      if (value !== undefined) {
        objects.set(destination, value);
      }
    },
    async list() {
      return [];
    },
    presignGet: (key) => key,
    presignPut: (key) => key,
  };
}

/** Runs the published bundle with Bun, outside nsjail, and waits for the broker handshake. */
function directSupervisor(options: {
  readonly pluginId: string;
  readonly bundlePath: string;
  readonly channel: BrokerChannel;
}): SandboxSupervisor {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let ready = false;

  return {
    pluginId: options.pluginId,
    get ready() {
      return ready;
    },
    status: () => ({ pluginId: options.pluginId, state: ready ? "ready" : "idle" }),
    async start() {
      const hello = options.channel.waitForHello(15_000);
      child = Bun.spawn(["bun", join(options.bundlePath, "server.ts")], {
        cwd: options.bundlePath,
        env: {
          PATH: Bun.env.PATH ?? "",
          PLUGIN_ID: options.pluginId,
          PLUGIN_SOCKET: options.channel.socketPath,
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      await hello;
      ready = true;
      return { pluginId: options.pluginId, state: "ready" };
    },
    async stop() {
      ready = false;
      child?.kill();
      await child?.exited;
    },
  } as unknown as SandboxSupervisor;
}

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.member_id;
}

async function pluginRow(database: TestDatabase) {
  const [row] = (await database.sql`
    SELECT state, enabled, bundle_key, checksum, error FROM core.plugins WHERE plugin_id = ${PLUGIN}
  `) as Array<{
    state: string;
    enabled: boolean;
    bundle_key: string | null;
    checksum: string | null;
    error: string | null;
  }>;
  return row;
}

interface Harness {
  readonly database: TestDatabase;
  readonly baseUrl: string;
  readonly storage: ReturnType<typeof memoryStorage>;
  readonly manager: PluginManager;
  readonly transports: Map<string, BrokerChannel>;
  readonly hooks: PluginHookRegistry;
  readonly admin: string;
  renderDemo(): Promise<string>;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "plugin_install" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        flagsSeedModule,
        themesSeedModule,
      ]),
    });

    const packages = await buildPluginPackages();
    const catalog: Catalog = {
      version: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      packages: packages.map((entry) => entry.package),
    };
    const marketplace = Bun.serve({
      port: 0,
      fetch: createMarketplaceHandler(catalog, await signCatalog(catalog), packages),
    });
    const stateDir = await mkdtemp(join(tmpdir(), "bulletin-plugin-install-"));
    const storage = memoryStorage();
    const transports = new Map<string, BrokerChannel>();
    const hooks = new PluginHookRegistry();
    const connections = new PluginConnectionManager({ adminUrl: database.url, maxConnections: 8 });
    const active = async (pluginId: string): Promise<boolean> => {
      const rows = (await database.sql`
        SELECT enabled AND state = 'active' AS active FROM core.plugins WHERE plugin_id = ${pluginId}
      `) as Array<{ active: boolean }>;
      return rows[0]?.active === true;
    };
    const manager = new PluginManager({
      sql: database.sql,
      logger,
      stateDir,
      pluginDatabaseUrl: database.url,
      connections,
      core: new CoreApiClient({ baseUrl: "http://127.0.0.1:9", token: "test" }),
      cache: new CacheInvalidator({ bump: async () => {}, logger }),
      nodeEnv: "test",
      isActive: active,
      grants: async () => ({ capabilities: ["template"], egressHosts: [] }),
      hooks,
      transports,
      bundles: new Map(),
      storage,
      quota: { quotaBytes: 64 * 1024 * 1024, intervalMs: 3_600_000 },
      createSupervisor: ({ pluginId, bundlePath, channel }) =>
        directSupervisor({ pluginId, bundlePath, channel }),
    });
    const versions = await createTagVersions({
      sql: database.sql,
      heartbeatMs: 100,
      heartbeatTimeoutMs: 1_000,
    });
    const memberRow = (await database.sql`
      SELECT i.member_id::text AS member_id, m.display_name
      FROM pii.identities i JOIN core.members m ON m.id = i.member_id
      WHERE i.sub = 'member-1'
    `) as Array<{ member_id: string; display_name: string | null }>;
    const session: UserAppSessionContext = {
      memberId: memberRow[0]?.member_id ?? "",
      sessionId: "0",
      reauthAt: new Date().toISOString(),
      locale: "en",
      displayName: memberRow[0]?.display_name ?? null,
    };

    try {
      await run({
        database,
        baseUrl: marketplace.url.origin,
        storage,
        manager,
        transports,
        hooks,
        admin: await memberId(database, "admin"),
        async renderDemo() {
          const [generation] = (await database.sql`
            SELECT generation FROM core.plugin_generation WHERE id = true
          `) as Array<{ generation: number }>;
          const result = await renderDemoRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session,
            forumId: "2",
            showDeleted: false,
            pluginsGeneration: generation?.generation ?? 1,
            colourScheme: "system",
            cache: createRenderCache({ tags: versions }),
            tagVersions: versions,
          });
          return result.html;
        },
      });
    } finally {
      await manager.close();
      await versions.close();
      await connections.close();
      marketplace.stop(true);
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}

integrationDescribe("marketplace plugin install", () => {
  test("a staff install runs the plugin and renders its slot; disable, enable and uninstall follow", async () => {
    await withHarness(async (harness) => {
      const { database, manager, storage } = harness;
      const notified: string[] = [];
      const listener = await database.sql.listen(PLUGINS_NOTIFY_CHANNEL, (payload) => {
        notified.push(payload);
      });

      try {
        expect(await harness.renderDemo()).not.toContain(NOTICE);

        const review = await reviewMarketplacePlugin(database.sql, {
          baseUrl: harness.baseUrl,
          pluginId: PLUGIN,
        });
        expect(review).toMatchObject({
          ok: true,
          review: { id: PLUGIN, capabilities: ["template"], egressHosts: [] },
        });

        const installed = await requestPluginInstall(database.sql, {
          storage,
          baseUrl: harness.baseUrl,
          pluginId: PLUGIN,
          approval: { capabilities: ["template"], egressHosts: [] },
          actorId: harness.admin,
        });
        expect(installed).toEqual({ ok: true });

        // The verified bytes are in object storage; the row holds the key and checksum only.
        const requested = await pluginRow(database);
        expect(requested).toMatchObject({ state: "installing", enabled: true });
        const stored = storage.objects.get(requested?.bundle_key ?? "");
        expect(stored).toBeDefined();
        expect(
          createHash("sha256")
            .update(stored ?? new Uint8Array())
            .digest("hex"),
        ).toBe(requested?.checksum ?? "");
        await Bun.sleep(100);
        expect(notified).toContain(PLUGIN);

        await manager.reconcile();
        expect((await pluginRow(database))?.state).toBe("active");
        expect(harness.transports.has(PLUGIN)).toBe(true);
        expect(harness.hooks.get(PLUGIN)?.manifest.templateFragments[0]?.name).toBe(
          "demo.after.topics",
        );
        expect(await harness.renderDemo()).toContain(NOTICE);

        const steps = (await database.sql`
          SELECT step, state FROM core.plugin_operations WHERE plugin_id = ${PLUGIN} ORDER BY id
        `) as Array<{ step: string; state: string }>;
        expect(steps).toEqual([
          { step: "requested", state: "completed" },
          { step: "activate", state: "running" },
          { step: "activate", state: "completed" },
        ]);

        // A second install of a running plugin is refused.
        expect(
          await requestPluginInstall(database.sql, {
            storage,
            baseUrl: harness.baseUrl,
            pluginId: PLUGIN,
            approval: { capabilities: ["template"], egressHosts: [] },
            actorId: harness.admin,
          }),
        ).toEqual({ ok: false, code: "already_installed" });

        await disablePlugin(database.sql, PLUGIN, harness.admin);
        await manager.reconcile();
        expect(harness.transports.has(PLUGIN)).toBe(false);
        expect(await harness.renderDemo()).not.toContain(NOTICE);

        expect(await enablePlugin(database.sql, PLUGIN, harness.admin)).toEqual({ ok: true });
        await manager.reconcile();
        expect((await pluginRow(database))?.state).toBe("active");
        expect(harness.transports.has(PLUGIN)).toBe(true);
        expect(await harness.renderDemo()).toContain(NOTICE);

        await uninstallPlugin(database.sql, PLUGIN, harness.admin, "keep");
        await manager.reconcile();
        expect((await pluginRow(database))?.state).toBe("uninstalled");
        expect(harness.transports.has(PLUGIN)).toBe(false);
        expect(await harness.renderDemo()).not.toContain(NOTICE);
      } finally {
        await listener.unlisten();
      }
    });
  }, 120_000);

  test("refuses an approval that does not match the manifest", async () => {
    await withHarness(async (harness) => {
      const result = await requestPluginInstall(harness.database.sql, {
        storage: harness.storage,
        baseUrl: harness.baseUrl,
        pluginId: PLUGIN,
        approval: { capabilities: [], egressHosts: [] },
        actorId: harness.admin,
      });

      expect(result).toEqual({ ok: false, code: "approval_mismatch" });
      expect(await pluginRow(harness.database)).toBeUndefined();
      expect(harness.storage.objects.size).toBe(0);

      expect(
        await requestPluginInstall(harness.database.sql, {
          storage: harness.storage,
          baseUrl: harness.baseUrl,
          pluginId: "no-such-plugin",
          approval: { capabilities: [], egressHosts: [] },
          actorId: harness.admin,
        }),
      ).toEqual({ ok: false, code: "not_found" });
    });
  }, 60_000);

  test("a stored bundle that fails its checksum is marked failed and never runs", async () => {
    await withHarness(async (harness) => {
      await requestPluginInstall(harness.database.sql, {
        storage: harness.storage,
        baseUrl: harness.baseUrl,
        pluginId: PLUGIN,
        approval: { capabilities: ["template"], egressHosts: [] },
        actorId: harness.admin,
      });
      const key = (await pluginRow(harness.database))?.bundle_key ?? "";
      const tampered = new Uint8Array(harness.storage.objects.get(key) ?? new Uint8Array());
      tampered[600] = (tampered[600] ?? 0) ^ 0xff;
      harness.storage.objects.set(key, tampered);

      await harness.manager.reconcile();

      const row = await pluginRow(harness.database);
      expect(row).toMatchObject({ state: "failed", enabled: false });
      expect(row?.error).toContain("checksum");
      expect(harness.transports.has(PLUGIN)).toBe(false);
      expect(await harness.renderDemo()).not.toContain(NOTICE);
    });
  }, 60_000);

  test("install, enable and review are denied without acp.plugins, and install needs step-up", async () => {
    await withHarness(async (harness) => {
      const { database } = harness;
      const member = await memberId(database, "member-1");

      // Members may open the console here, but only plugin managers may install.
      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'acp.access', to_jsonb(true) FROM core.groups WHERE key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;

      const call = async (id: string, memberId: string, lastAuthAt: Date): Promise<Response> => {
        const route = STAFF_ROUTES.find((entry) => entry.id === id);

        if (route === undefined) {
          throw new Error(`Missing route ${id}`);
        }

        const url = new URL(`http://staff.localhost${route.path}?pluginId=${PLUGIN}`);
        const request = new Request(url, {
          method: route.method,
          ...(route.method === "POST"
            ? {
                body: JSON.stringify({
                  pluginId: PLUGIN,
                  approved: true,
                  capabilities: ["template"],
                  egressHosts: [],
                }),
              }
            : {}),
        });
        return authorizeStaffRoute(route, {
          request,
          url,
          session: { memberId, lastAuthAt } as SessionRecord,
          sql: database.sql,
          checks: [],
          storage: harness.storage,
        });
      };

      for (const id of ["plugins.review", "plugins.install", "plugins.enable"]) {
        expect((await call(id, member, new Date())).status).toBe(403);
      }

      const stale = await call("plugins.install", harness.admin, new Date(Date.now() - 3_600_000));
      expect(stale.status).toBe(401);
      expect(await stale.json()).toEqual({ code: "step_up_required" });

      expect(await pluginRow(database)).toBeUndefined();
      expect(harness.storage.objects.size).toBe(0);
    });
  }, 60_000);
});
