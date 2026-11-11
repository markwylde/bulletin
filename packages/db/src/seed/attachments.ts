import { renderContent } from "@bulletin/content";
import { sha256Hex, syncPostAttachments } from "@bulletin/domain/attachments";
import {
  processAttachmentBytes,
  processAvatarImage,
} from "@bulletin/domain/attachments/processing";
import { slugify } from "@bulletin/domain/urls";
import {
  attachmentKey,
  avatarKey,
  processingKey,
  quarantineKey,
  type StorageClient,
  thumbnailKeyFor,
} from "@bulletin/storage";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

/** A small, valid 8×8 PNG used for every seeded avatar and image attachment. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQYlWPQSDnxHx9mGBkKAFtclMHoLjVbAAAAAElFTkSuQmCC";

const AVATAR_SUBS = ["member-1", "member-2", "admin"] as const;

async function memberId(sql: SQL, sub: string): Promise<string> {
  const [row] = (await sql`
    SELECT member_id::text AS member_id
    FROM pii.identities
    WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing seed member ${sub}`);
  }

  return row.member_id;
}

async function forumId(sql: SQL, slug: string): Promise<string> {
  const [row] = (await sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing seed forum ${slug}`);
  }

  return row.id;
}

function pngBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(PNG, "base64"));
}

async function insertReadyAttachment(
  sql: SQL,
  input: {
    readonly memberId: string;
    readonly filename: string;
    readonly declaredType: string;
    readonly verifiedType: string;
    readonly declaredBytes: number;
    readonly storageKey: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly downloadCount: number;
  },
): Promise<string> {
  const [row] = (await sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      snapshot_key, storage_key, size_bytes, sha256, verified_type, download_count,
      expires_at
    )
    VALUES (
      ${input.memberId}, 'ready', ${input.filename}, ${input.declaredType},
      ${input.declaredBytes}, ${quarantineKey()}, ${processingKey(crypto.randomUUID())},
      ${input.storageKey}, ${input.sizeBytes}, ${input.sha256}, ${input.verifiedType},
      ${input.downloadCount}, NULL
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Could not seed attachment ${input.filename}`);
  }

  return row.id;
}

async function seedImageAttachment(
  sql: SQL,
  storage: StorageClient | undefined,
  member: string,
  filename: string,
  downloadCount: number,
): Promise<string> {
  const source = pngBytes();
  const processed = await processAttachmentBytes(source, "image/png");

  if (processed.bytes === undefined) {
    throw new Error("Seed image did not produce bytes");
  }

  const storageKey = attachmentKey(crypto.randomUUID());

  if (storage !== undefined) {
    await storage.put(storageKey, processed.bytes, { contentType: processed.contentType });

    if (processed.thumbnail !== undefined) {
      await storage.put(thumbnailKeyFor(storageKey), processed.thumbnail, {
        contentType: "image/webp",
      });
    }
  }

  return insertReadyAttachment(sql, {
    memberId: member,
    filename,
    declaredType: "image/png",
    verifiedType: processed.contentType,
    declaredBytes: source.byteLength,
    storageKey,
    sizeBytes: processed.bytes.byteLength,
    sha256: sha256Hex(processed.bytes),
    downloadCount,
  });
}

async function seedFileAttachment(
  sql: SQL,
  storage: StorageClient | undefined,
  member: string,
  filename: string,
  body: string,
  downloadCount: number,
): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const storageKey = attachmentKey(crypto.randomUUID());

  if (storage !== undefined) {
    await storage.put(storageKey, bytes, { contentType: "text/plain" });
  }

  return insertReadyAttachment(sql, {
    memberId: member,
    filename,
    declaredType: "text/plain",
    verifiedType: "text/plain",
    declaredBytes: bytes.byteLength,
    storageKey,
    sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
    downloadCount,
  });
}

async function seedAvatar(
  sql: SQL,
  storage: StorageClient | undefined,
  member: string,
): Promise<void> {
  const processed = await processAvatarImage(pngBytes());

  if (storage !== undefined) {
    for (const variant of ["lg", "md", "sm"] as const) {
      await storage.put(avatarKey(member, processed.hash, variant), processed.sizes[variant], {
        contentType: "image/webp",
      });
    }
  }

  await sql`
    UPDATE core.members
    SET avatar_hash = ${processed.hash}, avatar_updated_at = now()
    WHERE id = ${member}
  `;
}

interface SeedTopicInput {
  readonly forumSlug: string;
  readonly authorSub: string;
  readonly title: string;
  readonly bodyMd: string;
}

async function seedTopic(
  sql: SQL,
  input: SeedTopicInput,
): Promise<{ readonly postId: string; readonly forumId: string }> {
  const forum = await forumId(sql, input.forumSlug);
  const author = await memberId(sql, input.authorSub);
  const rendered = await renderContent(input.bodyMd, {
    profile: "post",
    context: { kind: "forum_post", forumId: forum },
    authorId: author,
  });
  const createdAt = new Date(Date.now() - 30 * 60 * 1_000);
  const [topic] = (await sql`
    INSERT INTO core.topics (forum_id, title, slug, starter_id, created_at, updated_at)
    VALUES (
      ${forum}, ${input.title}, ${slugify(input.title)}, ${author}, ${createdAt}, ${createdAt}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (topic === undefined) {
    throw new Error(`Could not seed topic ${input.title}`);
  }

  const [post] = (await sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position, created_at
    )
    VALUES (
      ${topic.id}, ${author}, ${rendered.bodyMd}, ${rendered.bodyHtml},
      ${rendered.bodyText}, ${rendered.renderVersion}, ${rendered.sanitiserVersion},
      1, ${createdAt}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (post === undefined) {
    throw new Error(`Could not seed post for ${input.title}`);
  }

  await sql`
    UPDATE core.topics
    SET first_post_id = ${post.id}, last_post_id = ${post.id}, last_post_at = ${createdAt}
    WHERE id = ${topic.id}
  `;
  await sql`
    UPDATE core.members SET post_count = post_count + 1 WHERE id = ${author}
  `;
  await syncPostAttachments(sql, {
    postId: post.id,
    authorId: author,
    bodyHtml: rendered.bodyHtml,
  });

  return { postId: post.id, forumId: forum };
}

/**
 * Seeds a few public avatars and real attachments in posts, including one in the staff-only
 * forum (task 6.3). The objects are stored when the caller supplies a storage client; pure
 * database tests still get the rows and metadata.
 */
export const attachmentSeedModule: SeedModule = {
  name: "attachments",
  dependsOn: ["base", "forums", "groups", "members", "topics"],
  async run({ sql, storage }) {
    // Avatars and attachments are object-backed; pure database tests run without storage.
    if (storage === undefined) {
      return;
    }

    for (const sub of AVATAR_SUBS) {
      await seedAvatar(sql, storage, await memberId(sql, sub));
    }

    const publicAuthor = await memberId(sql, "member-1");
    const image = await seedImageAttachment(sql, storage, publicAuthor, "garden-photo.png", 4);
    const notes = await seedFileAttachment(
      sql,
      storage,
      publicAuthor,
      "garden-notes.txt",
      "The garden is coming along nicely.\n",
      2,
    );

    await seedTopic(sql, {
      forumSlug: "off-topic",
      authorSub: "member-1",
      title: "A garden update with photos",
      bodyMd: `A photo and my notes from the garden.\n\n![Garden photo](attachment:${image})\n\n[Garden notes](attachment:${notes})`,
    });

    const staffAuthor = await memberId(sql, "admin");
    const staffNotes = await seedFileAttachment(
      sql,
      storage,
      staffAuthor,
      "staff-room-notes.txt",
      "Notes for the staff room only.\n",
      1,
    );

    await seedTopic(sql, {
      forumSlug: "staff-room",
      authorSub: "admin",
      title: "Staff room attachments",
      bodyMd: `Staff notes are attached.\n\n[Staff notes](attachment:${staffNotes})`,
    });
  },
};
