import { describe, expect, test } from "bun:test";
import { transitionAttachment } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, run);
}

async function createMember(database: TestDatabase, name: string): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name)
    VALUES (${name})
    RETURNING id
  `) as Array<{ id: string }>;
  const id = member?.id;

  if (id === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  return id;
}

interface PostFixture {
  readonly topicId: string;
  readonly postId: string;
}

async function createPost(database: TestDatabase, memberId: string): Promise<PostFixture> {
  const [category] = (await database.sql`
    INSERT INTO core.forums (type, title, slug)
    VALUES ('category', 'Community', 'community')
    RETURNING id
  `) as Array<{ id: string }>;
  const [forum] = (await database.sql`
    INSERT INTO core.forums (parent_id, type, title, slug)
    VALUES (${category?.id ?? null}, 'forum', 'General Discussion', 'general-discussion')
    RETURNING id
  `) as Array<{ id: string }>;

  if (category === undefined || forum === undefined) {
    throw new Error("Could not create the forum");
  }

  const [topic] = (await database.sql`
    INSERT INTO core.topics (forum_id, title, slug, starter_id)
    VALUES (${forum.id}, 'Attachment thread', 'attachment-thread', ${memberId})
    RETURNING id
  `) as Array<{ id: string }>;

  if (topic === undefined) {
    throw new Error("Could not create the topic");
  }

  const [post] = (await database.sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position
    )
    VALUES (${topic.id}, ${memberId}, 'See attached', '<p>See attached</p>', 'See attached', 1, 1, 1)
    RETURNING id
  `) as Array<{ id: string }>;

  if (post === undefined) {
    throw new Error("Could not create the post");
  }

  return { topicId: topic.id, postId: post.id };
}

async function createAttachment(
  database: TestDatabase,
  memberId: string,
  filename = "report.pdf",
): Promise<string> {
  const [attachment] = (await database.sql`
    INSERT INTO core.attachments (
      member_id, filename, declared_type, declared_bytes, quarantine_key
    )
    VALUES (
      ${memberId}, ${filename}, 'application/pdf', 1024,
      ${`quarantine/${crypto.randomUUID()}`}
    )
    RETURNING id
  `) as Array<{ id: string }>;
  const id = attachment?.id;

  if (id === undefined) {
    throw new Error("Could not create the attachment");
  }

  return id;
}

async function readAttachment(database: TestDatabase, id: string) {
  const [row] = (await database.sql`
    SELECT state, snapshot_key, storage_key, size_bytes, sha256, verified_type,
      rejection_code, download_count, expires_at
    FROM core.attachments
    WHERE id = ${id}
  `) as Array<{
    state: string;
    snapshot_key: string | null;
    storage_key: string | null;
    size_bytes: string | null;
    sha256: string | null;
    verified_type: string | null;
    rejection_code: string | null;
    download_count: string;
    expires_at: Date | null;
  }>;

  if (row === undefined) {
    throw new Error("Attachment disappeared");
  }

  return {
    ...row,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    download_count: Number(row.download_count),
  };
}

/**
 * Bun's `expect(promise).rejects` does not settle for Bun SQL queries, so awaiting the query
 * ourselves keeps these tests honest.
 */
async function queryError(query: Promise<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected the query to fail");
}

const SNAPSHOT_HASH = "a".repeat(64);
const PUBLISHED_HASH = "b".repeat(64);

integrationDescribe("attachment state machine", () => {
  test("moves pending through snapshotted and processing to ready", async () => {
    await withDb("attach_states", async (database) => {
      const memberId = await createMember(database, "State Tester");
      const id = await createAttachment(database, memberId);

      const snapshotted = await transitionAttachment(database.sql, {
        id,
        from: "pending",
        to: "snapshotted",
        snapshotKey: "processing/snapshot-1",
        sizeBytes: 1024,
        sha256: SNAPSHOT_HASH,
      });

      expect(snapshotted?.state).toBe("snapshotted");
      expect(snapshotted?.snapshotKey).toBe("processing/snapshot-1");
      expect(snapshotted?.sizeBytes).toBe(1024);
      expect(snapshotted?.sha256).toBe(SNAPSHOT_HASH);

      const processing = await transitionAttachment(database.sql, {
        id,
        from: "snapshotted",
        to: "processing",
      });
      expect(processing?.state).toBe("processing");

      const ready = await transitionAttachment(database.sql, {
        id,
        from: "processing",
        to: "ready",
        storageKey: "att/published-1",
        sizeBytes: 900,
        sha256: PUBLISHED_HASH,
        verifiedType: "application/pdf",
      });

      expect(ready?.state).toBe("ready");
      expect(ready?.storageKey).toBe("att/published-1");
      expect(ready?.sizeBytes).toBe(900);
      expect(ready?.sha256).toBe(PUBLISHED_HASH);
      expect(ready?.verifiedType).toBe("application/pdf");
      expect(ready?.downloadCount).toBe(0);

      const stored = await readAttachment(database, id);
      expect(stored.state).toBe("ready");
      expect(stored.snapshot_key).toBe("processing/snapshot-1");
      expect(stored.storage_key).toBe("att/published-1");
    });
  });

  test("a replayed transition is a no-op and cannot overwrite the snapshot", async () => {
    await withDb("attach_replay", async (database) => {
      const memberId = await createMember(database, "Replay Tester");
      const id = await createAttachment(database, memberId);

      const first = await transitionAttachment(database.sql, {
        id,
        from: "pending",
        to: "snapshotted",
        snapshotKey: "processing/snapshot-1",
        sizeBytes: 1024,
        sha256: SNAPSHOT_HASH,
      });
      expect(first?.state).toBe("snapshotted");

      const replay = await transitionAttachment(database.sql, {
        id,
        from: "pending",
        to: "snapshotted",
        snapshotKey: "processing/attacker-replaced",
        sizeBytes: 512,
        sha256: PUBLISHED_HASH,
      });
      expect(replay).toBeNull();

      const stored = await readAttachment(database, id);
      expect(stored.state).toBe("snapshotted");
      expect(stored.snapshot_key).toBe("processing/snapshot-1");
      expect(stored.size_bytes).toBe(1024);
      expect(stored.sha256).toBe(SNAPSHOT_HASH);
    });
  });

  test("rejection records a reason and keeps the snapshot for cleanup", async () => {
    await withDb("attach_reject", async (database) => {
      const memberId = await createMember(database, "Reject Tester");
      const id = await createAttachment(database, memberId, "photo.jpg");

      await transitionAttachment(database.sql, {
        id,
        from: "pending",
        to: "snapshotted",
        snapshotKey: "processing/snapshot-2",
        sizeBytes: 1024,
        sha256: SNAPSHOT_HASH,
      });
      await transitionAttachment(database.sql, { id, from: "snapshotted", to: "processing" });

      const rejected = await transitionAttachment(database.sql, {
        id,
        from: "processing",
        to: "rejected",
        rejectionCode: "type_not_allowed",
      });

      expect(rejected?.state).toBe("rejected");
      expect(rejected?.rejectionCode).toBe("type_not_allowed");
      expect(rejected?.snapshotKey).toBe("processing/snapshot-2");
      expect(rejected?.storageKey).toBeNull();

      const ready = await transitionAttachment(database.sql, {
        id,
        from: "processing",
        to: "ready",
        storageKey: "att/never",
        sizeBytes: 1,
        sha256: PUBLISHED_HASH,
        verifiedType: "image/jpeg",
      });
      expect(ready).toBeNull();
    });
  });

  test("the database refuses a state whose fields do not match", async () => {
    await withDb("attach_constraint", async (database) => {
      const memberId = await createMember(database, "Constraint Tester");
      const id = await createAttachment(database, memberId);

      expect(
        await queryError(database.sql`
          UPDATE core.attachments SET state = 'ready' WHERE id = ${id}
        `),
      ).toContain("attachments_state_fields_check");

      expect(
        await queryError(database.sql`
          UPDATE core.attachments SET state = 'nonsense' WHERE id = ${id}
        `),
      ).toContain("attachments_state_check");
    });
  });
});

integrationDescribe("attachment relations and quota", () => {
  test("links an attachment to a post once and cascades the link, not the file", async () => {
    await withDb("attach_relations", async (database) => {
      const memberId = await createMember(database, "Link Tester");
      const { postId } = await createPost(database, memberId);
      const id = await createAttachment(database, memberId);

      await database.sql`
        INSERT INTO core.post_attachments (post_id, attachment_id, position, inline)
        VALUES (${postId}, ${id}, 0, false)
      `;
      expect(
        await queryError(database.sql`
          INSERT INTO core.post_attachments (post_id, attachment_id, position)
          VALUES (${postId}, ${id}, 1)
        `),
      ).toContain("post_attachments_pkey");

      await database.sql`DELETE FROM core.posts WHERE id = ${postId}`;

      const links = (await database.sql`
        SELECT 1 FROM core.post_attachments WHERE attachment_id = ${id}
      `) as unknown[];
      const files = (await database.sql`
        SELECT 1 FROM core.attachments WHERE id = ${id}
      `) as unknown[];
      expect(links).toHaveLength(0);
      expect(files).toHaveLength(1);
    });
  });

  test("member storage holds used and reserved bytes and refuses negatives", async () => {
    await withDb("attach_quota", async (database) => {
      const memberId = await createMember(database, "Quota Tester");

      const [row] = (await database.sql`
        INSERT INTO core.member_storage (member_id, used_bytes, reserved_bytes)
        VALUES (${memberId}, 2048, 1024)
        RETURNING used_bytes, reserved_bytes
      `) as Array<{ used_bytes: string; reserved_bytes: string }>;
      expect(row?.used_bytes).toBe("2048");
      expect(row?.reserved_bytes).toBe("1024");

      expect(
        await queryError(database.sql`
          UPDATE core.member_storage SET used_bytes = -1 WHERE member_id = ${memberId}
        `),
      ).toContain("member_storage_used_bytes_check");
    });
  });

  test("avatar fields store a content hash and a staff block window", async () => {
    await withDb("attach_avatar", async (database) => {
      const memberId = await createMember(database, "Avatar Tester");
      const hash = "c".repeat(64);

      await database.sql`
        UPDATE core.members
        SET avatar_hash = ${hash}, avatar_updated_at = now(), avatar_blocked_until = now() + interval '30 days'
        WHERE id = ${memberId}
      `;

      const [member] = (await database.sql`
        SELECT avatar_hash, avatar_updated_at IS NOT NULL AS has_updated_at,
          avatar_blocked_until > now() AS blocked
        FROM core.members
        WHERE id = ${memberId}
      `) as Array<{ avatar_hash: string; has_updated_at: boolean; blocked: boolean }>;
      expect(member?.avatar_hash).toBe(hash);
      expect(member?.has_updated_at).toBe(true);
      expect(member?.blocked).toBe(true);

      expect(
        await queryError(database.sql`
          UPDATE core.members SET avatar_hash = 'not-a-hash' WHERE id = ${memberId}
        `),
      ).toContain("members_avatar_hash_check");
    });
  });
});
