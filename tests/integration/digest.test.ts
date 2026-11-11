import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { follow } from "@bulletin/domain/follows";
import { digestFrequency, queueDigests, setDigestFrequency } from "@bulletin/domain/notifications";
import { bumpPermVersion, forumActionMask } from "@bulletin/domain/permissions";
import { reply, startTopic } from "@bulletin/domain/topics";
import { createMailStore } from "@bulletin/mock-mail/message";
import { startSmtpServer } from "@bulletin/mock-mail/smtp";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { userOrigin } from "@bulletin/test-utils/urls";
import type { PgBoss } from "pg-boss";
import { notificationDigestResponse } from "../../apps/user-api/src/notifications.ts";
import { createDigestJobs, deliverDigestEmail } from "../../apps/workers/src/digest.ts";
import type { EmailOptions } from "../../apps/workers/src/email.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const SECRET = "digest-test-secret";

async function withMailStack(
  run: (context: {
    readonly database: TestDatabase;
    readonly store: ReturnType<typeof createMailStore>;
    readonly options: EmailOptions;
  }) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const store = createMailStore();
  const server = startSmtpServer({ port: 0, store, hostname: "127.0.0.1" });

  try {
    await withTestDatabase({ adminUrl, prefix: "digest" }, async (database) => {
      await runSeeds({
        sql: database.sql,
        registry: new SeedRegistry([
          baseSeedModule,
          flagsSeedModule,
          permissionFixtureSeedModule,
          groupsSeedModule,
          forumExtrasSeedModule,
          membersSeedModule,
        ]),
      });

      await run({
        database,
        store,
        options: {
          smtpUrl: `smtp://127.0.0.1:${server.port}`,
          mailFrom: "Bulletin <no-reply@bulletin.test>",
          userOrigin: userOrigin(),
          unsubscribeSecret: SECRET,
        },
      });
    });
  } finally {
    server.stop();
  }
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

function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

integrationDescribe("digests", () => {
  test("a weekly digest lists followed activity the member can read", async () => {
    await withMailStack(async ({ database, store, options }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      await setDigestFrequency(database.sql, member, "weekly");
      await follow(database.sql, { memberId: member, kind: "forum", id: forum });

      const newTopic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Digest new topic",
          bodyMd: "Body.",
        }),
      );

      const queued = await queueDigests(database.sql, "weekly");
      expect(queued).toHaveLength(1);
      expect(
        await deliverDigestEmail(
          database.sql,
          options,
          queued[0] ?? {
            intentId: "0",
            deliveryId: "0",
          },
        ),
      ).toBe("sent");

      const message = store.list()[0];
      expect(message?.subject).toBe("Your weekly digest");
      expect(message?.text).toContain("Digest new topic");
      expect(message?.text).toContain(`/topic/${newTopic.topicId}-digest-new-topic`);

      const [delivery] = (await database.sql`
        SELECT delivered_at FROM core.delivery_intents WHERE id = ${queued[0]?.intentId ?? "0"}
      `) as Array<{ delivered_at: Date | null }>;
      expect(delivery?.delivered_at).not.toBeNull();
      expect(await digestFrequency(database.sql, member)).toBe("weekly");
    });
  }, 60_000);

  test("content that became unreadable after the window is not sent", async () => {
    await withMailStack(async ({ database, store, options }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      await setDigestFrequency(database.sql, member, "weekly");
      await follow(database.sql, { memberId: member, kind: "forum", id: forum });
      expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Will become hidden",
          bodyMd: "Body.",
        }),
      );

      // Revoke the members' read bit on Off Topic before the digest is built.
      await database.sql`
        INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
        SELECT ${forum}, m.id, ${forumActionMask(["show"])}, false
        FROM core.masks m
        WHERE m.key = 'standard'
        ON CONFLICT (forum_id, mask_id) DO UPDATE
          SET actions = EXCLUDED.actions, inherits = EXCLUDED.inherits
      `;
      await bumpPermVersion(database.sql);

      const queued = await queueDigests(database.sql, "weekly");
      expect(queued).toHaveLength(1);
      expect(
        await deliverDigestEmail(
          database.sql,
          options,
          queued[0] ?? {
            intentId: "0",
            deliveryId: "0",
          },
        ),
      ).toBe("skipped");
      expect(store.list()).toEqual([]);
    });
  }, 60_000);

  test("only subscribed members are queued, with the right cadence", async () => {
    await withMailStack(async ({ database }) => {
      const member = await memberId(database, "member-2");
      const daily = await memberId(database, "member-fr");

      await setDigestFrequency(database.sql, member, "weekly");
      await setDigestFrequency(database.sql, daily, "daily");

      expect(await queueDigests(database.sql, "weekly")).toHaveLength(1);
      expect(await queueDigests(database.sql, "daily")).toHaveLength(1);
    });
  }, 30_000);

  test("registers both crons and the per-member email queue", async () => {
    await withMailStack(async ({ database, options }) => {
      const calls: string[] = [];
      const boss = {
        getQueue: async () => null,
        createQueue: async (name: string) => {
          calls.push(`create:${name}`);
        },
        updateQueue: async (name: string) => {
          calls.push(`update:${name}`);
        },
        work: async (name: string) => {
          calls.push(`work:${name}`);
        },
        schedule: async (name: string, cron: string) => {
          calls.push(`schedule:${name}:${cron}`);
        },
        send: async (name: string) => {
          calls.push(`send:${name}`);
        },
        offWork: async (name: string) => {
          calls.push(`off:${name}`);
        },
      } as unknown as PgBoss;

      const jobs = await createDigestJobs({ ...options, boss, sql: database.sql });

      expect(calls).toContain("schedule:digest.daily:0 7 * * *");
      expect(calls).toContain("schedule:digest.weekly:0 7 * * 1");
      expect(calls).toContain("work:digest.email");
      await jobs.stop();
    });
  }, 30_000);

  test("the API saves a validated digest frequency", async () => {
    await withMailStack(async ({ database }) => {
      const member = await memberId(database, "member-2");

      const saved = await notificationDigestResponse(
        database.sql,
        member,
        new Request("http://user.test/api/notifications/digest", {
          method: "POST",
          body: JSON.stringify({ frequency: "weekly" }),
        }),
      );
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ ok: true, frequency: "weekly" });
      expect(await digestFrequency(database.sql, member)).toBe("weekly");

      const invalid = await notificationDigestResponse(
        database.sql,
        member,
        new Request("http://user.test/api/notifications/digest", {
          method: "POST",
          body: JSON.stringify({ frequency: "hourly" }),
        }),
      );
      expect(invalid.status).toBe(400);
    });
  }, 30_000);
});
