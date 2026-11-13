import { describe, expect, test } from "bun:test";
import { createLogger } from "@bulletin/config";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { type PluginManifest, parsePluginManifest } from "@bulletin/plugin-sdk/manifest";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { readInternal } from "../../apps/plugin-host/src/hooks/http.ts";
import { PluginHookRegistry } from "../../apps/plugin-host/src/hooks/registry.ts";
import { type HookTransport, PluginHookRunner } from "../../apps/plugin-host/src/hooks/runner.ts";
import { createTopicResponse } from "../../apps/user-api/src/topics.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const logger = createLogger({
  service: "plugin-veto-posting-test",
  level: "error",
  sink: () => {},
});

const TOKEN = "bulletin-development-only-internal-token";

function manifest(): PluginManifest {
  return parsePluginManifest({
    id: "tips",
    name: "Tips",
    version: "1.0.0",
    sdkVersion: "^2.0.0",
    entry: "server.ts",
    capabilities: ["veto"],
    vetoes: [{ hook: "post.write", reasonKey: "plugin.tips.rejected" }],
  });
}

/** A plugin-host whose veto answers `{ allow: false }`, as the SDK allows. */
function hostServer(): ReturnType<typeof Bun.serve> {
  const registry = new PluginHookRegistry();
  registry.install(manifest(), { generation: 1 });
  const transport: HookTransport = {
    request<T>(method: string): Promise<T> {
      if (method === "hook.veto") {
        return Promise.resolve({ allow: false } as T);
      }

      return Promise.reject(new Error(`unexpected method ${method}`));
    },
  };
  const runner = new PluginHookRunner({ transport, registry, logger });
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const internal = await readInternal(request, {
        runner,
        registry,
        transport,
        token: TOKEN,
        frameAncestors: [],
        logger,
        bundles: new Map(),
      });
      return internal ?? new Response("not found", { status: 404 });
    },
  });

  return server;
}

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "plugin_veto_post" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

function request(body: unknown): Request {
  return new Request("http://bulletin.localhost/api/forums/1/topics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

integrationDescribe("plugin veto posting", () => {
  test("rejects a post when the plugin answers without a reason", async () => {
    await withSeededDb(async (database) => {
      const server = hostServer();
      const previous = Bun.env.PLUGIN_HOST_INTERNAL_URL;
      Bun.env.PLUGIN_HOST_INTERNAL_URL = server.url.origin;

      try {
        const forum = await forumId(database, "off-topic");
        const member = await memberId(database, "member-1");
        const response = await createTopicResponse(
          database.sql,
          { memberId: member, sessionId: "0" },
          forum,
          request({ title: "Vetoed topic", bodyMd: "Buy my stuff." }),
        );

        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({
          code: "plugin_veto",
          reason: "plugin.tips.rejected",
        });

        const rows = (await database.sql`
          SELECT count(*)::int AS count FROM core.topics WHERE title = 'Vetoed topic'
        `) as Array<{ count: number }>;
        expect(rows[0]?.count).toBe(0);
      } finally {
        server.stop(true);
        if (previous === undefined) {
          delete Bun.env.PLUGIN_HOST_INTERNAL_URL;
        } else {
          Bun.env.PLUGIN_HOST_INTERNAL_URL = previous;
        }
      }
    });
  }, 30_000);
});
