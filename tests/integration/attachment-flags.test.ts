import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { bumpFlagTag } from "@bulletin/db/flags";
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
import { setMemberAvatar } from "@bulletin/domain/member";
import { startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import type { StorageClient } from "@bulletin/storage";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  attachmentDeleteRoute,
  attachmentFinaliseRoute,
  attachmentRequestRoute,
} from "../../apps/user-api/src/attachments.ts";
import { avatarRemoveRoute, avatarUploadRoute } from "../../apps/user-api/src/avatars.ts";
import { createUserApiFlags } from "../../apps/user-api/src/flag-guard.ts";
import { buildAccountPage } from "../../apps/user-app/src/account/page.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { accountContract } from "../../apps/user-app/src/contracts.ts";
import { renderThemedPage } from "../../apps/user-app/src/theme/render.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "attachment_flags" }, async (database) => {
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

async function setFlag(database: TestDatabase, key: string, value: boolean): Promise<void> {
  await database.sql`
    UPDATE core.feature_flags
    SET default_value = ${value}, rules = '[]'::jsonb, updated_at = now()
    WHERE key = ${key}
  `;
  await bumpFlagTag(database.sql);
}

async function createAttachment(database: TestDatabase, member: string): Promise<string> {
  const [row] = (await database.sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      snapshot_key, storage_key, size_bytes, sha256, verified_type
    )
    VALUES (
      ${member}, 'ready', 'flag-notes.pdf', 'application/pdf', 1024,
      ${`quarantine/${crypto.randomUUID()}`}, ${`processing/${crypto.randomUUID()}`},
      ${`att/${crypto.randomUUID()}`}, 1024, ${"a".repeat(64)}, 'application/pdf'
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create the attachment");
  }

  return row.id;
}

integrationDescribe("attachment and avatar feature flags", () => {
  test("the real routes answer 404 and make no change when the flags are off", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const attachmentId = await createAttachment(database, member);
      const flags = createUserApiFlags(database.sql);
      const storage = {} as StorageClient;
      const session = { memberId: member };
      const uploadRequest = () =>
        new Request("http://bulletin.localhost/api/attachments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            forumId: forum,
            filename: "blocked.txt",
            contentType: "text/plain",
            sizeBytes: 10,
          }),
        });

      await setFlag(database, "attachments", false);

      expect(
        (await attachmentRequestRoute(database.sql, storage, flags, session, uploadRequest()))
          .status,
      ).toBe(404);
      const count = (await database.sql`
        SELECT count(*)::int AS count FROM core.attachments
      `) as Array<{ count: number }>;
      expect(count[0]?.count).toBe(1);

      expect(
        (await attachmentFinaliseRoute(database.sql, storage, flags, session, attachmentId)).status,
      ).toBe(404);
      expect(
        (
          await attachmentDeleteRoute(
            database.sql,
            flags,
            session,
            attachmentId,
            new Request("http://bulletin.localhost/api/attachments/x/delete", {
              method: "POST",
              body: "{}",
            }),
          )
        ).status,
      ).toBe(404);
      expect(
        (await database.sql`
        SELECT 1 FROM core.attachments WHERE id = ${attachmentId}
      `) as unknown[],
      ).toHaveLength(1);

      await setFlag(database, "avatar_upload", false);
      expect(
        (
          await avatarUploadRoute(
            database.sql,
            storage,
            flags,
            session,
            new Request("http://bulletin.localhost/api/me/avatar", {
              method: "POST",
              body: JSON.stringify({ imageBase64: "AAAA" }),
            }),
          )
        ).status,
      ).toBe(404);
      expect((await avatarRemoveRoute(database.sql, storage, flags, session)).status).toBe(404);
      expect(
        (await database.sql`
        SELECT avatar_hash FROM core.members WHERE id = ${member}
      `) as Array<{ avatar_hash: string | null }>,
      ).toEqual([{ avatar_hash: null }]);
    });
  }, 30_000);

  test("the account template hides the avatar editor when its flag is off", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");

      for (const enabled of [false, true]) {
        const account = await buildAccountPage({
          sql: database.sql,
          memberId: member,
          locale: "en",
          translate,
          avatarUploadEnabled: enabled,
        });

        if (account === null) {
          throw new Error("Expected the account page");
        }

        const page = await renderThemedPage({
          sql: database.sql,
          boardName: "Bulletin",
          locale: "en",
          translate,
          template: "account",
          viewModel: account.viewModel,
          breadcrumbs: account.breadcrumbs,
          route: accountContract,
        });

        expect(page.html.includes("data-account-avatar")).toBe(enabled);
      }
    });
  }, 30_000);

  test("the avatar flag switches populated author cards back to initials", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const topic = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Avatar flag card",
        bodyMd: "Hello with an avatar.",
      });

      if (!topic.ok) {
        throw new Error(`Could not start the topic: ${topic.code}`);
      }

      await setMemberAvatar(database.sql, member, "b".repeat(64));
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const cache = createRenderCache({ tags: versions });

      try {
        const render = () =>
          renderTopicRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            ref: `${topic.result.topicId}-avatar-flag-card`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        const before = await render();
        expect(before.kind === "page" ? before.html : "").toContain("data-member-avatar");

        await setFlag(database, "avatar_upload", false);
        await versions.refresh();
        const after = await render();
        const html = after.kind === "page" ? after.html : "";

        expect(html).toContain("data-member-initials");
        expect(html).not.toContain("data-member-avatar");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("the attachments flag changes the topic variant and hides the file list", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const attachmentId = await createAttachment(database, member);
      const topic = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Flagged attachment",
        bodyMd: `[flag-notes.pdf](attachment:${attachmentId})`,
      });

      if (!topic.ok) {
        throw new Error(`Could not create the topic: ${topic.code}`);
      }

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const cache = createRenderCache({ tags: versions });

      try {
        const cases: VariantCase[] = [
          {
            name: "attachments on",
            render: async () => {
              const result = await renderTopicRoute({
                sql: database.sql,
                locale: "en",
                translate,
                session: null,
                ref: `${topic.result.topicId}-flagged-attachment`,
                pluginsGeneration: 1,
                colourScheme: "system",
                cache,
                tagVersions: versions,
              });

              return {
                variant: result.variant ?? "",
                html: result.kind === "page" ? result.html : "",
                ...(result.cache === null ? {} : { cache: result.cache }),
              };
            },
          },
          {
            name: "attachments off",
            setup: () => setFlag(database, "attachments", false),
            teardown: () => setFlag(database, "attachments", true),
            render: async () => {
              const result = await renderTopicRoute({
                sql: database.sql,
                locale: "en",
                translate,
                session: null,
                ref: `${topic.result.topicId}-flagged-attachment`,
                pluginsGeneration: 1,
                colourScheme: "system",
                cache,
                tagVersions: versions,
              });

              return {
                variant: result.variant ?? "",
                html: result.kind === "page" ? result.html : "",
                ...(result.cache === null ? {} : { cache: result.cache }),
              };
            },
          },
        ];

        await assertCacheVariants({
          route: "/topic/[ref]",
          cases,
          cache,
          leaks: [
            {
              description: "the attachment file list is absent when the flag is off",
              markers: ["flag-notes.pdf", "data-post-files"],
              absentFrom: ["attachments off"],
            },
          ],
        });
      } finally {
        await versions.close();
      }
    });
  }, 45_000);
});
