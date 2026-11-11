import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { processAvatarDeletions } from "@bulletin/db/jobs";
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
import {
  clearMemberAvatar,
  readMemberAvatar,
  setMemberAvatar,
  withAvatarObjectLock,
} from "@bulletin/domain/member";
import { startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { createS3Handler } from "@bulletin/mock-s3/app";
import { createMemoryStore } from "@bulletin/mock-s3/memory";
import { createStorage, type StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import sharp from "sharp";
import { removeMemberAvatarForStaff } from "../../apps/staff-api/src/members.ts";
import { avatarRemoveResponse, avatarUploadResponse } from "../../apps/user-api/src/avatars.ts";
import { avatarImageResponse } from "../../apps/user-app/src/avatars/image.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

interface Harness {
  readonly database: TestDatabase;
  readonly storage: StorageClient;
  close(): void;
}

async function withHarness(
  prefix: string,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createS3Handler({
      store: createMemoryStore(),
      bucket: "bulletin",
      credentials: {
        accessKeyId: "bulletin",
        secretAccessKey: "bulletin-secret",
        region: "us-east-1",
      },
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const storage = createStorage({
    endpoint,
    publicEndpoint: endpoint,
    bucket: "bulletin",
    accessKeyId: "bulletin",
    secretAccessKey: "bulletin-secret",
    region: "us-east-1",
  });

  try {
    await withTestDatabase({ adminUrl, prefix }, async (database) => {
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
      await run({ database, storage, close: () => server.stop(true) });
    });
  } finally {
    server.stop(true);
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

async function setAvatarLimit(database: TestDatabase, kb: number): Promise<void> {
  await database.sql`
    INSERT INTO core.group_settings (group_id, key, value)
    SELECT id, 'members.avatar_max_kb', to_jsonb(${kb}::int)
    FROM core.groups
    WHERE key IN ('members', 'regulars')
    ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
  `;
}

async function imageBytes(size = 64, background = "#336699", noise = false): Promise<Uint8Array> {
  if (noise) {
    const width = size * 2;
    const height = size;
    const raw = new Uint8Array(width * height * 3);

    for (let index = 0; index < raw.length; index += 1) {
      raw[index] = (index * 2_654_435_761) >>> 24;
    }

    return new Uint8Array(
      await sharp(raw, { raw: { width, height, channels: 3 } })
        .jpeg()
        .toBuffer(),
    );
  }

  return new Uint8Array(
    await sharp({
      create: { width: size * 2, height: size, channels: 3, background },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: "Bulletin" } })
      .toBuffer(),
  );
}

function avatarRequest(imageBase64: string): Request {
  return new Request("http://bulletin.localhost/api/me/avatar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageBase64 }),
  });
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

integrationDescribe("avatars", () => {
  test("uploads three WebP sizes and replaces the old content-hashed objects", async () => {
    await withHarness("avatar_upload", async ({ database, storage }) => {
      const member = await memberId(database, "member-1");
      const first = await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(base64(await imageBytes())),
      );

      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { avatarUrl: string };
      expect(firstBody.avatarUrl).toMatch(
        new RegExp(`^/avatars/${member}/[0-9a-f]{64}-md\\.webp$`),
      );
      const firstHash = (await readMemberAvatar(database.sql, member))?.hash ?? "";
      expect(firstHash).toMatch(/^[0-9a-f]{64}$/);

      for (const variant of ["lg", "md", "sm"]) {
        expect(await storage.exists(`av/${member}/${firstHash}-${variant}.webp`)).toBe(true);
      }

      const second = await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(base64(await imageBytes(80, "#996633"))),
      );
      expect(second.status).toBe(200);
      const secondHash = (await readMemberAvatar(database.sql, member))?.hash ?? "";
      expect(secondHash).not.toBe(firstHash);
      expect(await storage.exists(`av/${member}/${firstHash}-lg.webp`)).toBe(false);

      const file = await avatarImageResponse(
        database.sql,
        storage,
        member,
        `${secondHash}-md.webp`,
      );
      expect(file.status).toBe(302);
      const cache = file.headers.get("cache-control") ?? "";
      expect(cache).toBe("public, max-age=86400, immutable");
      expect(Number(/max-age=(\d+)/.exec(cache)?.[1] ?? 0)).toBeLessThan(604_800);
      const location = file.headers.get("location");

      if (location === null) {
        throw new Error("Missing avatar redirect");
      }

      const locationUrl = new URL(location);
      expect(Number(locationUrl.searchParams.get("X-Amz-Expires"))).toBe(604_800);
      const bytes = await fetch(location);
      expect(bytes.status).toBe(200);
      expect(bytes.headers.get("content-type")).toBe("image/webp");
      expect((await sharp(new Uint8Array(await bytes.arrayBuffer())).metadata()).width).toBe(128);
    });
  }, 30_000);

  test("uploading the same bytes twice keeps the active objects", async () => {
    await withHarness("avatar_same_hash", async ({ database, storage }) => {
      const member = await memberId(database, "member-1");
      const bytes = base64(await imageBytes());

      await avatarUploadResponse(database.sql, storage, { memberId: member }, avatarRequest(bytes));
      const hash = (await readMemberAvatar(database.sql, member))?.hash ?? "";
      const again = await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(bytes),
      );

      expect(again.status).toBe(200);
      expect((await readMemberAvatar(database.sql, member))?.hash).toBe(hash);

      for (const variant of ["lg", "md", "sm"]) {
        expect(await storage.exists(`av/${member}/${hash}-${variant}.webp`)).toBe(true);
      }
    });
  }, 30_000);

  test("honours the group limit and the staff block", async () => {
    await withHarness("avatar_limits", async ({ database, storage }) => {
      const member = await memberId(database, "member-1");
      const bytes = base64(await imageBytes());

      await setAvatarLimit(database, 0);
      expect(
        (
          await avatarUploadResponse(
            database.sql,
            storage,
            { memberId: member },
            avatarRequest(bytes),
          )
        ).status,
      ).toBe(403);

      await setAvatarLimit(database, 1);
      const tooLarge = await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(base64(await imageBytes(600, "#336699", true))),
      );
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.json()).toMatchObject({ code: "avatar_too_large" });

      await setAvatarLimit(database, 512);
      await database.sql`
        UPDATE core.members SET avatar_blocked_until = now() + interval '30 days'
        WHERE id = ${member}
      `;
      const blocked = await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(bytes),
      );
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({ code: "avatar_blocked" });
    });
  }, 30_000);

  test("retries a failed avatar object deletion and blocks the old URL immediately", async () => {
    await withHarness("avatar_deletion_retry", async ({ database, storage }) => {
      const member = await memberId(database, "member-1");
      const admin = await memberId(database, "admin");
      await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(base64(await imageBytes())),
      );
      const hash = (await readMemberAvatar(database.sql, member))?.hash ?? "";

      const failing = {
        ...storage,
        async delete(key: string) {
          if (key.startsWith("av/")) {
            throw new Error("storage down");
          }

          await storage.delete(key);
        },
      } as StorageClient;

      const removed = await removeMemberAvatarForStaff(database.sql, failing, {
        actorId: admin,
        memberId: member,
        blockDays: 0,
      });
      expect(removed.ok).toBe(true);

      const pending = (await database.sql`
        SELECT count(*)::int AS count FROM core.avatar_deletions
        WHERE member_id = ${member} AND avatar_hash = ${hash}
      `) as Array<{ count: number }>;
      expect(pending[0]?.count).toBe(1);

      // The hash check makes the old URL 404 even while the object is still present.
      expect(
        (await avatarImageResponse(database.sql, storage, member, `${hash}-lg.webp`)).status,
      ).toBe(404);
      expect(await storage.exists(`av/${member}/${hash}-lg.webp`)).toBe(true);

      const retried = await processAvatarDeletions(database.sql, storage);
      expect(retried.deleted).toBe(1);
      expect(await storage.exists(`av/${member}/${hash}-lg.webp`)).toBe(false);
      const remaining = (await database.sql`
        SELECT count(*)::int AS count FROM core.avatar_deletions
      `) as Array<{ count: number }>;
      expect(remaining[0]?.count).toBe(0);
    });
  }, 30_000);

  test("a retried deletion cannot remove a newly restored avatar", async () => {
    await withHarness("avatar_deletion_race", async ({ database, storage }) => {
      const member = await memberId(database, "member-1");
      const restored = base64(await imageBytes());
      await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(restored),
      );
      const hash = (await readMemberAvatar(database.sql, member))?.hash ?? "";

      // A replacement avatar queues the previous hash's objects for deletion.
      await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(base64(await imageBytes(80, "#996633"))),
      );
      const queued = (await database.sql`
        SELECT count(*)::int AS count FROM core.avatar_deletions
        WHERE member_id = ${member} AND avatar_hash = ${hash}
      `) as Array<{ count: number }>;
      expect(queued[0]?.count).toBe(1);

      let releaseDeletion = (): void => undefined;
      const deletionGate = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
      let signalDeletion = (): void => undefined;
      const deletionStarted = new Promise<void>((resolve) => {
        signalDeletion = resolve;
      });
      let gated = false;
      const slow = {
        ...storage,
        async delete(key: string) {
          if (!gated && key.startsWith(`av/${member}/${hash}-`)) {
            gated = true;
            signalDeletion();
            await deletionGate;
          }

          await storage.delete(key);
        },
      } as StorageClient;

      // Pause the worker between its hash check and the object deletion.
      const worker = processAvatarDeletions(database.sql, slow);
      await deletionStarted;

      // Re-upload the very bytes whose objects the worker is deleting.
      let settled = false;
      const restore = avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(restored),
      ).then((response) => {
        settled = true;
        return response;
      });

      // The upload is serialised behind the worker's lock: it must not publish between the
      // worker's hash check and its object deletion, however long the deletion takes.
      for (let attempt = 0; attempt < 100 && !settled; attempt += 1) {
        await Bun.sleep(20);
      }
      expect(settled).toBe(false);

      releaseDeletion();
      const [deletion, response] = await Promise.all([worker, restore]);

      expect(deletion.deleted).toBe(1);
      expect(response.status).toBe(200);
      expect((await readMemberAvatar(database.sql, member))?.hash).toBe(hash);

      for (const variant of ["lg", "md", "sm"]) {
        expect(await storage.exists(`av/${member}/${hash}-${variant}.webp`)).toBe(true);
      }
    });
  }, 30_000);

  test("enforces the merged group dimension limits", async () => {
    await withHarness("avatar_dimensions", async ({ database, storage }) => {
      const member = await memberId(database, "member-1");
      const admin = await memberId(database, "admin");

      for (const key of ["members.avatar_max_width", "members.avatar_max_height"]) {
        await database.sql`
          INSERT INTO core.group_settings (group_id, key, value)
          SELECT id, ${key}, '32'::jsonb
          FROM core.groups WHERE key IN ('members', 'regulars')
          ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
        `;
      }

      const rejected = await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(base64(await imageBytes(64))),
      );
      expect(rejected.status).toBe(413);
      expect(await rejected.json()).toMatchObject({ code: "avatar_too_large" });

      const accepted = await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: admin },
        avatarRequest(base64(await imageBytes(64))),
      );
      expect(accepted.status).toBe(200);
    });
  }, 30_000);

  test("a member removes their own avatar and its objects", async () => {
    await withHarness("avatar_remove", async ({ database, storage }) => {
      const member = await memberId(database, "member-1");
      await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(base64(await imageBytes())),
      );
      const hash = (await readMemberAvatar(database.sql, member))?.hash ?? "";

      const removed = await avatarRemoveResponse(database.sql, storage, { memberId: member });

      expect(removed.status).toBe(200);
      expect((await readMemberAvatar(database.sql, member))?.hash).toBeNull();
      expect(await storage.exists(`av/${member}/${hash}-lg.webp`)).toBe(false);
    });
  }, 30_000);

  test("staff removal requires members.edit, sets the block and logs the action", async () => {
    await withHarness("avatar_staff", async ({ database, storage }) => {
      const member = await memberId(database, "member-1");
      const admin = await memberId(database, "admin");
      await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(base64(await imageBytes())),
      );

      const denied = await removeMemberAvatarForStaff(database.sql, storage, {
        actorId: member,
        memberId: member,
        blockDays: 30,
      });
      expect(denied).toEqual({ ok: false, code: "forbidden" });

      const removed = await removeMemberAvatarForStaff(database.sql, storage, {
        actorId: admin,
        memberId: member,
        blockDays: 30,
      });
      expect(removed.ok).toBe(true);

      const [row] = (await database.sql`
        SELECT avatar_hash, avatar_blocked_until > now() AS blocked
        FROM core.members WHERE id = ${member}
      `) as Array<{ avatar_hash: string | null; blocked: boolean }>;
      expect(row).toEqual({ avatar_hash: null, blocked: true });

      const log = (await database.sql`
        SELECT action, summary FROM core.admin_log
        WHERE action = 'member.avatar.remove' AND target_id = ${member}
      `) as Array<{ action: string; summary: unknown }>;
      expect(log).toHaveLength(1);
      expect(JSON.stringify(log[0]?.summary)).toContain("30");

      const blockedUpload = await avatarUploadResponse(
        database.sql,
        storage,
        { memberId: member },
        avatarRequest(base64(await imageBytes())),
      );
      expect(blockedUpload.status).toBe(403);

      // An upload that passed its early policy check still cannot commit after the block.
      expect(await setMemberAvatar(database.sql, member, "d".repeat(64))).toBe("blocked");
      expect((await readMemberAvatar(database.sql, member))?.hash).toBeNull();
    });
  }, 30_000);

  test("protected avatar queries run on the reserved connection with a one-slot pool", async () => {
    await withHarness("avatar_pool", async (harness) => {
      const first = await memberId(harness.database, "member-1");
      const second = await memberId(harness.database, "member-2");
      const small = new SQL(harness.database.url, { max: 1, connectionTimeout: 2 });

      try {
        // Two concurrent lock holders share one pool slot: each must query through its own
        // reserved connection or the holder waits for a connection it is itself occupying.
        const results = await Promise.all([
          withAvatarObjectLock(small, first, async (tx) => {
            const avatar = await readMemberAvatar(tx, first);
            return avatar !== null;
          }),
          withAvatarObjectLock(small, second, async (tx) => {
            const avatar = await readMemberAvatar(tx, second);
            return avatar !== null;
          }),
        ]);

        expect(results).toEqual([true, true]);
      } finally {
        await small.close();
      }
    });
  }, 30_000);

  test("an avatar change rebuilds the member card but not the post blocks", async () => {
    await withHarness("avatar_cache", async ({ database }) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const topic = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Avatar cache test",
        bodyMd: "Hello from an avatar test.",
      });

      if (!topic.ok) {
        throw new Error(`Could not start the topic: ${topic.code}`);
      }

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const base = createRenderCache({ tags: versions });
        const calls: Array<{ readonly key: string; readonly status: string }> = [];
        const counted = {
          ...base,
          getOrRender: async (request: Parameters<typeof base.getOrRender>[0]) => {
            const result = await base.getOrRender(request);
            calls.push({ key: result.key, status: result.status });
            return result;
          },
        };
        const render = () =>
          renderTopicRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            ref: `${topic.result.topicId}-avatar-cache-test`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache: counted,
            tagVersions: versions,
          });

        const before = await render();
        expect(before.kind === "page" ? before.html : "").toContain("data-member-initials");
        expect(before.kind === "page" ? before.html : "").not.toContain("data-member-avatar");

        calls.length = 0;
        await setMemberAvatar(database.sql, member, "a".repeat(64));
        await versions.refresh();
        const after = await render();
        const html = after.kind === "page" ? after.html : "";

        expect(html).toContain(`/avatars/${member}/${"a".repeat(64)}-sm.webp`);
        expect(html).toContain("data-member-avatar");
        expect(
          calls.some(
            (call) =>
              call.key.startsWith(`post-block:${topic.result.postId}:`) && call.status === "hit",
          ),
        ).toBe(true);
        expect(
          calls.some(
            (call) => call.key.startsWith(`member-card:${member}:`) && call.status === "miss",
          ),
        ).toBe(true);

        await clearMemberAvatar(database.sql, member);
        await versions.refresh();
        const removed = await render();
        expect(removed.kind === "page" ? removed.html : "").toContain("data-member-initials");
      } finally {
        await versions.close();
      }
    });
  }, 45_000);
});
