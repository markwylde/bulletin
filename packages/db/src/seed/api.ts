import { hashApiKey } from "@bulletin/domain/api";
import { displayNameSkeleton } from "@bulletin/domain/member";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

const WEBHOOK_SECRET = "bulletin-dev-webhook-secret-0123456789";
const WEBHOOK_URL_ENV = "BULLETIN_SEED_WEBHOOK_URL";
const PERSONAL_KEY_PREFIX = "5eeda001";
const INTEGRATION_KEY_PREFIX = "5eeda002";

function generatedKey(prefix: string): string {
  return `blt_${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  )}`;
}

function pepper(): string {
  return Bun.env.SESSION_SECRET ?? "bulletin-development-only-session-secret";
}

async function memberId(sql: SQL, sub: string): Promise<string> {
  const [row] = (await sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing seed member ${sub}`);
  }

  return row.member_id;
}

async function groupId(sql: SQL, key: string): Promise<string> {
  const [row] = (await sql`
    SELECT id::text AS id FROM core.groups WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing seed group ${key}`);
  }

  return row.id;
}

/**
 * Local integration examples: one personal key, one integration key with a service member and
 * one webhook pointed at `mocks/webhooks`. A seeded post.edited event makes the delivery
 * visible after the workers' relay starts (tasks 5.2; ADR 0016).
 */
export const apiSeedModule: SeedModule = {
  name: "public-api",
  dependsOn: ["base", "forums", "groups", "members", "topics"],
  async run({ sql }) {
    const admin = await memberId(sql, "admin");
    const personalMember = await memberId(sql, "member-es");
    const membersGroup = await groupId(sql, "members");
    const [serviceMember] = (await sql`
      INSERT INTO core.members (display_name, name_skeleton, is_service)
      VALUES ('Integration Bot', ${displayNameSkeleton("Integration Bot")}, true)
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (serviceMember === undefined) {
      throw new Error("Could not seed the integration service member");
    }

    await sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      VALUES (${serviceMember.id}, ${membersGroup}, true)
    `;

    const personalKey = generatedKey(PERSONAL_KEY_PREFIX);
    const integrationKey = generatedKey(INTEGRATION_KEY_PREFIX);
    const keyPepper = pepper();

    await sql`
      INSERT INTO core.api_keys (
        prefix, hash, principal_member_id, kind, label, scopes
      )
      VALUES (
        ${PERSONAL_KEY_PREFIX}, ${hashApiKey(keyPepper, personalKey)},
        ${personalMember}, 'personal', 'Seed personal key',
        '{read:forums,read:topics}'::text[]
      )
    `;
    await sql`
      INSERT INTO core.api_keys (
        prefix, hash, principal_member_id, kind, label, scopes
      )
      VALUES (
        ${INTEGRATION_KEY_PREFIX}, ${hashApiKey(keyPepper, integrationKey)},
        ${serviceMember.id}, 'integration', 'Integration Bot',
        '{read:forums,read:topics}'::text[]
      )
    `;

    const webhookUrl = Bun.env[WEBHOOK_URL_ENV]?.trim() ?? "";

    if (webhookUrl === "") {
      return;
    }

    await sql`
      INSERT INTO core.webhooks (
        url, secret, events, principal_member_id, content_fields, enabled, created_by
      )
      VALUES (
        ${webhookUrl}, ${WEBHOOK_SECRET},
        '{topic.created,post.created,post.edited}'::text[],
        ${serviceMember.id}, '{}'::text[], true, ${admin}
      )
    `;

    // One event is enough to prove delivery to the local mock without requiring a browser
    // action. post.edited avoids adding another notification to the seeded inbox.
    await sql`
      INSERT INTO core.events (
        type, aggregate_type, aggregate_id, aggregate_version, payload_ids
      )
      SELECT
        'post.edited', 'post', post.id, 1,
        jsonb_build_object(
          'postId', post.id::text,
          'topicId', topic.id::text,
          'forumId', topic.forum_id::text,
          'authorId', post.author_id::text,
          'editorId', post.author_id::text
        )
      FROM core.posts post
      JOIN core.topics topic ON topic.id = post.topic_id
      WHERE topic.title = 'What are you reading this month?'
      ORDER BY post.position, post.id
      LIMIT 1
    `;
  },
};
