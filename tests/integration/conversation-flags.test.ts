import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { bumpFlagTag, loadStoredFlags, syncFlagDefinitions } from "@bulletin/db/flags";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import type { SessionRecord } from "@bulletin/domain/auth";
import { CODE_FLAG_DEFINITIONS, conversationsFlag } from "@bulletin/flags";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createUserApiFlags } from "../../apps/user-api/src/flag-guard.ts";
import { streamResponse } from "../../apps/user-api/src/stream.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderConversationsRoute } from "../../apps/user-app/src/conversations/route.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "conversation_flags" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function setConversationFlag(database: TestDatabase, enabled: boolean): Promise<void> {
  await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
  await database.sql`
    UPDATE core.feature_flags
    SET default_value = ${enabled}, updated_at = now()
    WHERE key = 'conversations'
  `;
  await bumpFlagTag(database.sql);
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

async function createSession(database: TestDatabase, member: string): Promise<SessionRecord> {
  const reauthAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  const [row] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${member}, 'user', decode(md5(random()::text), 'hex'), ${reauthAt})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create the session");
  }

  return {
    id: row.id,
    memberId: member,
    kind: "user",
    displayName: null,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    reauthAt,
    lastAuthAt: new Date(),
    reauthRetryCount: 0,
    revokedAt: null,
    rotatePending: false,
    viaPreviousToken: false,
    previousTokenExpiresAt: null,
  };
}

integrationDescribe("conversation feature flag", () => {
  test("is declared off by default and turned on by the seed", async () => {
    expect(CODE_FLAG_DEFINITIONS).toContain(conversationsFlag);
    expect(conversationsFlag).toMatchObject({
      key: "conversations",
      defaultValue: false,
      affectsRender: true,
      clientVisible: true,
    });

    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "conversation_flag_seed" }, async ({ sql }) => {
      await runSeeds({
        sql,
        registry: new SeedRegistry([baseSeedModule, flagsSeedModule]),
      });
      const stored = await loadStoredFlags(sql);
      expect(stored.find((flag) => flag.key === "conversations")?.defaultValue).toBe(true);
    });
  }, 60_000);

  test("server routes and the conversation stream answer 404 when the flag is off", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      await setConversationFlag(database, false);
      let flags = createUserApiFlags(database.sql);

      const denied = await flags.guard("conversations", member)(
        new Request("http://user.test/api/conversations"),
        () => new Response("ok"),
      );
      expect(denied.status).toBe(404);

      const session = await createSession(database, member);
      const streamDenied = await streamResponse({
        sql: database.sql,
        session,
        request: new Request("http://user.test/api/stream?conversation=1&message=0"),
        conversationsEnabled: false,
      });
      expect(streamDenied.status).toBe(404);

      await setConversationFlag(database, true);
      flags = createUserApiFlags(database.sql);
      const allowed = await flags.guard("conversations", member)(
        new Request("http://user.test/api/conversations"),
        () => new Response("ok"),
      );
      expect(allowed.status).toBe(200);
    });
  }, 60_000);

  test("the inbox page is a themed 404 while the flag is off", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const session = {
        memberId: member,
        sessionId: "0",
        reauthAt: new Date(Date.now() + 60_000).toISOString(),
        locale: "en" as const,
        displayName: "Regular Member One",
      };

      await setConversationFlag(database, false);
      const off = await renderConversationsRoute({
        sql: database.sql,
        locale: "en",
        translate,
        session,
        folder: "inbox",
        pluginsGeneration: 1,
        colourScheme: "system",
      });
      expect(off.status).toBe(404);
      expect(off.html).toContain("data-theme-error");

      await setConversationFlag(database, true);
      const on = await renderConversationsRoute({
        sql: database.sql,
        locale: "en",
        translate,
        session,
        folder: "inbox",
        pluginsGeneration: 1,
        colourScheme: "system",
      });
      expect(on.status).toBe(200);
      expect(on.html).toContain("data-conversations-page");
    });
  }, 60_000);

  test("the shared header omits the conversations link and the variant changes when toggled", async () => {
    await withDb(async (database) => {
      await setConversationFlag(database, false);
      const versions = await createTagVersions({ sql: database.sql, heartbeatMs: 100 });
      const cache = createRenderCache({ tags: versions });

      try {
        const render = async () =>
          renderHomeRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        await assertCacheVariants({
          route: "/",
          cache,
          cases: [
            {
              name: "off",
              setup: () => setConversationFlag(database, false),
              async render() {
                const result = await render();
                return {
                  variant: result.variant,
                  html: result.html,
                  ...(result.cache === null ? {} : { cache: result.cache }),
                };
              },
            },
            {
              name: "on",
              setup: () => setConversationFlag(database, true),
              async render() {
                const result = await render();
                return {
                  variant: result.variant,
                  html: result.html,
                  ...(result.cache === null ? {} : { cache: result.cache }),
                };
              },
            },
          ],
          leaks: [
            {
              markers: ["data-conversations-link", "data-account-conversations"],
              absentFrom: ["off"],
            },
          ],
        });
      } finally {
        await versions.close();
      }
    });
  }, 60_000);
});
