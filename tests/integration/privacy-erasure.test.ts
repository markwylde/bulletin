import { describe, expect, test } from "bun:test";
import { postTag, readTagVersion, topicTag } from "@bulletin/cache";
import { currentContentVersions } from "@bulletin/content";
import {
  ERASURE_STEPS,
  journalKeyFor,
  rerenderCursorKey,
  runErasureJob,
  runExportJob,
} from "@bulletin/db/jobs";
import { sessionCookieName } from "@bulletin/domain/auth";
import { saveDraft } from "@bulletin/domain/content";
import { requestDataErasure, requestDataExport } from "@bulletin/domain/privacy";
import { avatarKey, type StorageClient, thumbnailKeyFor } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import { requestDataErasureResponse } from "../../apps/user-api/src/data-erasure.ts";

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

function roleUrl(database: TestDatabase, role: string): string {
  const url = new URL(database.url);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function withRole(
  database: TestDatabase,
  role: string,
  run: (sql: SQL) => Promise<void>,
): Promise<void> {
  const sql = new SQL(roleUrl(database, role));

  try {
    await run(sql);
  } finally {
    await sql.close();
  }
}

interface RecordingStorage {
  readonly storage: StorageClient;
  readonly objects: Map<string, Uint8Array>;
  readonly deleted: string[];
  readonly failing: Set<string>;
}

function createStorage(): RecordingStorage {
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const failing = new Set<string>();

  return {
    objects,
    deleted,
    failing,
    storage: {
      async put(key, data) {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        objects.set(key, bytes);
        return bytes.byteLength;
      },
      async get(key) {
        return objects.get(key) ?? new Uint8Array();
      },
      async exists(key) {
        return objects.has(key);
      },
      async stat() {
        return { size: 0, contentType: "application/octet-stream", etag: "" };
      },
      async delete(key) {
        if (failing.has(key)) {
          throw new Error("storage unavailable");
        }
        deleted.push(key);
        objects.delete(key);
      },
      async copy(source, destination) {
        const bytes = objects.get(source);
        if (bytes !== undefined) {
          objects.set(destination, bytes);
        }
      },
      async list(prefix) {
        return [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({
            key,
            size: objects.get(key)?.byteLength ?? 0,
            lastModified: new Date(),
          }));
      },
      presignGet() {
        return "https://files.test/export";
      },
      presignPut() {
        return "https://files.test/upload";
      },
    },
  };
}

interface ErasureFixture {
  readonly memberId: string;
  readonly otherId: string;
  readonly token: string;
  readonly staffToken: string;
  readonly forumId: string;
  readonly topicId: string;
  readonly postId: string;
  readonly mentionPostId: string;
  readonly attachmentKey: string;
  readonly avatarHash: string;
  readonly sessionId: string;
  readonly apiKeyId: string;
  readonly pushDeviceId: string;
  readonly exportKey: string;
  readonly memberRequestId: string;
  readonly journalPrefix: string;
}

async function createFixtures(database: TestDatabase): Promise<ErasureFixture> {
  const [member] = (await database.sql`
    INSERT INTO core.members (
      display_name, name_skeleton, locale, about_md, about_html, signature_md,
      signature_html, custom_title, avatar_hash
    ) VALUES (
      'Alice Original', 'alice-original', 'en', 'Alice about', '<p>Alice about</p>',
      'Alice sig', '<p>Alice sig</p>', 'Alice title', ${"b".repeat(64)}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [other] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES ('Bob Other', 'bob-other')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined || other === undefined) {
    throw new Error("Could not create erasure members");
  }

  await database.sql`
    INSERT INTO pii.identities (member_id, issuer, sub, email)
    VALUES (${member.id}, 'https://auth.test', 'erase-alice', 'alice@example.test')
  `;
  await database.sql`
    INSERT INTO core.plugin_personal_data (plugin_id, table_name, member_column)
    VALUES ('sample-plugin', 'sample_notes', 'member_id')
  `;
  await database.sql`
    INSERT INTO core.member_name_history (member_id, old_name, new_name, changed_by)
    VALUES (${member.id}, 'Alice Old', 'Alice Original', ${member.id})
  `;
  await database.sql`
    INSERT INTO core.slug_history (kind, resource_id, slug)
    VALUES ('profile', ${member.id}, 'alice-old')
  `;
  const token = "erase-user-token";
  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${member.id}, 'user', sha256(convert_to(${token}, 'UTF8')), now() + interval '1 day')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [apiKey] = (await database.sql`
    INSERT INTO core.api_keys (prefix, hash, principal_member_id, kind, label)
    VALUES ('erasekey', sha256(convert_to('erase-key', 'UTF8')), ${member.id}, 'personal', 'Erase')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [push] = (await database.sql`
    INSERT INTO pii.push_subscriptions (
      member_id, endpoint, p256dh, auth_secret, label
    ) VALUES (
      ${member.id}, 'https://push.test/erase', 'key', 'auth', 'Erase device'
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (session === undefined || apiKey === undefined || push === undefined) {
    throw new Error("Could not create erasure credentials");
  }

  const [forum] = (await database.sql`
    INSERT INTO core.forums (type, title, slug) VALUES ('forum', 'Erase Forum', 'erase-forum')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [topic] = (await database.sql`
    INSERT INTO core.topics (forum_id, title, slug, starter_id)
    VALUES (${forum?.id}, 'Erase topic', 'erase-topic', ${member.id})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const posts = (await database.sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position
    )
    VALUES
      (${topic?.id}, ${member.id}, 'Alice first post', '<p>Alice first post</p>', 'Alice first post', 1, 1, 1),
      (${topic?.id}, ${other.id}, 'Hello @Alice Original and @Alice Old', '<p>Hello</p>', 'Hello', 1, 1, 2)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (forum === undefined || topic === undefined || posts.length !== 2) {
    throw new Error("Could not create erasure posts");
  }

  const postId = posts[0]?.id ?? "";
  const mentionPostId = posts[1]?.id ?? "";
  await database.sql`
    UPDATE core.posts
    SET mentioned_member_ids = ARRAY[${member.id}]::bigint[],
        render_version = 3000000
    WHERE id = ${mentionPostId}
  `;
  await database.sql`
    UPDATE core.posts SET render_version = 3000000, sanitiser_version = 1 WHERE id = ${postId}
  `;
  await database.sql`
    INSERT INTO core.quote_snapshots (
      source_kind, source_id, source_author_id, body_md, body_html, render_version, sanitiser_version
    ) VALUES (
      'post', ${postId}, ${member.id}, 'Alice first post', '<p>Alice first post</p>', 3000000, 1
    )
  `;
  await database.sql`
    INSERT INTO core.post_revisions (
      post_id, body_md, body_html, body_text, render_version, sanitiser_version,
      editor_id, edited_at
    ) VALUES (
      ${postId}, 'Old Alice body', '<p>Old Alice body</p>', 'Old Alice body', 1, 1,
      ${member.id}, now() - interval '1 hour'
    )
  `;
  await database.sql`
    INSERT INTO pii.ip_log (member_id, ip) VALUES (${member.id}, '198.51.100.1')
  `;
  await database.sql`
    INSERT INTO pii.post_ips (post_id, member_id, ip)
    VALUES (${postId}, ${member.id}, '198.51.100.1')
  `;
  await database.sql`
    INSERT INTO pii.access_grants (
      actor_member_id, subject_member_id, purpose, resource_type, resource_id,
      xact_id, expires_at
    ) VALUES (
      ${member.id}, ${member.id}, 'post_ip', 'post', ${postId}, pg_current_xact_id(), now() + interval '1 hour'
    )
  `;

  const attachmentKey = "att/erase-file";
  await database.sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      storage_key, size_bytes, sha256, verified_type
    ) VALUES (
      ${member.id}, 'ready', 'erase.txt', 'text/plain', 6, 'quarantine/erase',
      ${attachmentKey}, 6, ${"c".repeat(64)}, 'text/plain'
    )
  `;
  const [conversation] = (await database.sql`
    INSERT INTO core.conversations (title, starter_id)
    VALUES ('Erase conversation', ${member.id})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (conversation === undefined) {
    throw new Error("Could not create erasure conversation");
  }

  await database.sql`
    INSERT INTO core.conversation_participants (conversation_id, member_id)
    VALUES (${conversation.id}, ${member.id}), (${conversation.id}, ${other.id})
  `;
  await database.sql`
    INSERT INTO core.conversation_messages (conversation_id, author_id, body_md, body_html, body_text)
    VALUES (${conversation.id}, ${member.id}, 'Alice message', '<p>Alice message</p>', 'Alice message')
  `;
  const [reaction] = (await database.sql`
    INSERT INTO core.reactions (key, icon, label_key)
    VALUES ('erase_like', '👍', 'reaction.label.like')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (reaction === undefined) {
    throw new Error("Could not create erasure reaction");
  }

  await database.sql`
    INSERT INTO core.post_reactions (post_id, member_id, reaction_id)
    VALUES (${postId}, ${member.id}, ${reaction.id})
  `;
  const [poll] = (await database.sql`
    INSERT INTO core.polls (topic_id) VALUES (${topic.id}) RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [question] = (await database.sql`
    INSERT INTO core.poll_questions (poll_id, prompt)
    VALUES (${poll?.id}, 'Pick one') RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [choice] = (await database.sql`
    INSERT INTO core.poll_choices (poll_id, question_id, label)
    VALUES (${poll?.id}, ${question?.id}, 'Choice') RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (poll === undefined || question === undefined || choice === undefined) {
    throw new Error("Could not create erasure poll");
  }

  await database.sql`
    INSERT INTO core.poll_votes (poll_id, member_id) VALUES (${poll.id}, ${member.id})
  `;
  await database.sql`
    INSERT INTO core.poll_vote_choices (poll_id, member_id, question_id, choice_id)
    VALUES (${poll.id}, ${member.id}, ${question.id}, ${choice.id})
  `;
  await database.sql`
    INSERT INTO core.followed_topics (member_id, topic_id) VALUES (${member.id}, ${topic.id})
  `;
  await database.sql`
    INSERT INTO core.followed_forums (member_id, forum_id) VALUES (${member.id}, ${forum.id})
  `;
  await database.sql`
    INSERT INTO core.followed_members (follower_id, followed_id) VALUES (${member.id}, ${other.id})
  `;
  await database.sql`
    INSERT INTO core.follow_settings (member_id, auto_follow_topics) VALUES (${member.id}, true)
  `;
  await database.sql`
    INSERT INTO core.friendships (a_member_id, b_member_id, state, requested_by)
    VALUES (${member.id}, ${other.id}, 'accepted', ${member.id})
  `;
  await database.sql`
    INSERT INTO core.member_ignores (member_id, ignored_id) VALUES (${member.id}, ${other.id})
  `;
  await database.sql`
    INSERT INTO core.drafts (member_id, context_key, body_md)
    VALUES (${member.id}, 'new-topic:1', 'draft body')
  `;
  await database.sql`
    INSERT INTO core.member_prefs (member_id, staff_scheme, colour_scheme)
    VALUES (${member.id}, 'dark', 'dark')
  `;
  await database.sql`
    INSERT INTO core.notification_preferences (member_id, type, channel, enabled)
    VALUES (${member.id}, 'topic.reply', 'email', false)
  `;
  await database.sql`
    INSERT INTO core.digest_subscriptions (member_id, frequency) VALUES (${member.id}, 'daily')
  `;
  await database.sql`
    WITH event AS (
      INSERT INTO core.events (type, aggregate_type, aggregate_id, aggregate_version, payload_ids)
      VALUES (
        'member.created', 'member', ${member.id}, 1,
        jsonb_build_object('memberId', ${member.id}::text)
      )
      RETURNING id
    )
    INSERT INTO core.notification_events (event_id, member_id)
    SELECT id, ${member.id} FROM event
  `;
  await database.sql`
    INSERT INTO core.notifications (member_id, type) VALUES (${member.id}, 'topic.reply')
  `;
  await database.sql`
    INSERT INTO core.notifications (member_id, type, actor_id)
    VALUES (${other.id}, 'topic.reply', ${member.id})
  `;
  await database.sql`
    INSERT INTO core.delivery_intents (member_id, kind, ref_id, channel)
    SELECT ${member.id}, 'notification', id, 'email'
    FROM core.notifications WHERE member_id = ${member.id} LIMIT 1
  `;
  await database.sql`
    INSERT INTO core.member_storage (member_id, used_bytes, reserved_bytes)
    VALUES (${member.id}, 6, 0)
  `;
  await database.sql`
    INSERT INTO core.member_restrictions (member_id, kind) VALUES (${member.id}, 'cannot_post')
  `;
  await database.sql`
    INSERT INTO core.leaderboard_entries (period, metric, member_id, forum_id, value)
    VALUES ('all', 'posts', ${member.id}, ${forum.id}, 1)
  `;
  await database.sql`
    INSERT INTO core.moderators (forum_id, member_id, powers) VALUES (${forum.id}, ${member.id}, '{edit}')
  `;
  await database.sql`
    INSERT INTO core.forum_reads (member_id, forum_id) VALUES (${member.id}, ${forum.id})
  `;
  await database.sql`
    INSERT INTO core.topic_reads (member_id, topic_id) VALUES (${member.id}, ${topic.id})
  `;
  await database.sql`
    INSERT INTO core.conversation_daily_starts (member_id, day, starts)
    VALUES (${member.id}, current_date, 1)
  `;
  const [announcement] = (await database.sql`
    INSERT INTO core.announcements (title) VALUES ('Erase announcement') RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (announcement === undefined) {
    throw new Error("Could not create erasure announcement");
  }

  await database.sql`
    INSERT INTO core.announcement_dismissals (member_id, announcement_id, version)
    VALUES (${member.id}, ${announcement.id}, 1)
  `;
  const [profileField] = (await database.sql`
    INSERT INTO core.profile_fields (type, labels) VALUES ('short_text', '{"en":"Field"}'::jsonb)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (profileField === undefined) {
    throw new Error("Could not create erasure profile field");
  }

  await database.sql`
    INSERT INTO core.member_field_values (member_id, field_id, value)
    VALUES (${member.id}, ${profileField.id}, '"value"')
  `;
  const [badge] = (await database.sql`
    INSERT INTO core.badges (key, labels) VALUES ('erase-badge', '{"en":"Badge"}'::jsonb)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (badge === undefined) {
    throw new Error("Could not create erasure badge");
  }

  await database.sql`
    INSERT INTO core.member_badges (member_id, badge_id, awarded_by, reason)
    VALUES (${member.id}, ${badge.id}, ${other.id}, 'reason')
  `;
  const [warningReason] = (await database.sql`
    INSERT INTO core.warning_reasons (key, points, expiry_days)
    VALUES ('erase_reason', 1, 30) RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (warningReason === undefined) {
    throw new Error("Could not create erasure warning reason");
  }

  await database.sql`
    INSERT INTO core.warning_reason_labels (reason_id, locale, label)
    VALUES (${warningReason.id}, 'en', 'Erase warning')
  `;
  await database.sql`
    INSERT INTO core.warnings (member_id, reason_id, points, expires_at)
    VALUES (${member.id}, ${warningReason.id}, 1, now() + interval '30 days')
  `;
  const [report] = (await database.sql`
    INSERT INTO core.reports (target_type, target_id, status)
    VALUES ('member', ${member.id}, 'open') RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (report === undefined) {
    throw new Error("Could not create erasure report");
  }

  await database.sql`
    INSERT INTO core.report_reporters (report_id, reporter_id, reason)
    VALUES (${report.id}, ${member.id}, 'spam')
  `;
  await database.sql`
    INSERT INTO core.report_comments (report_id, actor_id, body)
    VALUES (${report.id}, ${member.id}, 'comment')
  `;
  const exportKey = "export/alice-export.zip";
  await database.sql`
    INSERT INTO pii.data_requests (
      member_id, kind, status, export_key, export_expires_at, completed_at
    ) VALUES (
      ${member.id}, 'export', 'completed', ${exportKey}, now() + interval '7 days', now()
    )
  `;

  const [admin] = (await database.sql`
    INSERT INTO core.members (display_name) VALUES ('Erase Admin') RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (admin === undefined) {
    throw new Error("Could not create erasure admin");
  }

  await database.sql`
    INSERT INTO core.member_groups (member_id, group_id, is_primary)
    SELECT ${admin.id}, id, true FROM core.groups WHERE key = 'administrators'
  `;
  const staffToken = "erase-staff-token";
  await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at)
    VALUES (
      ${admin.id}, 'staff', sha256(convert_to(${staffToken}, 'UTF8')), now() + interval '1 day', now()
    )
  `;

  return {
    memberId: member.id,
    otherId: other.id,
    token,
    staffToken,
    forumId: forum.id,
    topicId: topic.id,
    postId,
    mentionPostId,
    attachmentKey,
    avatarHash: "b".repeat(64),
    sessionId: session.id,
    apiKeyId: apiKey.id,
    pushDeviceId: push.id,
    exportKey,
    memberRequestId: "",
    journalPrefix: "journal/",
  };
}

async function approveErasure(
  database: TestDatabase,
  fixture: ErasureFixture,
  requestId: string,
): Promise<void> {
  await database.sql`
    SELECT pii.update_data_request(${fixture.staffToken}, ${requestId}, 'process', 'Approved')
  `;
}

integrationDescribe("member erasure", () => {
  test("lists retained records, including an active ban", async () => {
    await withDb("privacy_erasure_confirmation", async (database) => {
      const fixture = await createFixtures(database);
      await database.sql`
        INSERT INTO core.member_bans (member_id, reason, previous_groups)
        VALUES (${fixture.memberId}, 'Active ban', '[]'::jsonb)
      `;
      const cookie = `${sessionCookieName("user", "test")}=${fixture.token}`;
      const response = await requestDataErasureResponse(
        database.sql,
        fixture.memberId,
        new Request("http://bulletin.test/api/me/data-erasure", {
          method: "POST",
          headers: { cookie },
        }),
        "test",
      );

      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        requestId: string;
        retained: Array<{ key: string; basisKey: string }>;
      };
      expect(body.requestId).toBeString();
      expect(body.retained.map((entry) => entry.key)).toEqual(
        expect.arrayContaining(["dataRequests", "accessLog", "moderationLog", "warnings", "ban"]),
      );
      expect(body.retained.find((entry) => entry.key === "ban")?.basisKey).toBe(
        "privacy.erasure.retained.ban",
      );
    });
  }, 60_000);

  test("fences credentials, erases every personal record and journals the IDs", async () => {
    await withDb("privacy_erasure_full", async (database) => {
      const fixture = await createFixtures(database);
      const storage = createStorage();
      storage.objects.set(fixture.attachmentKey, new TextEncoder().encode("erase!"));
      storage.objects.set(
        thumbnailKeyFor(fixture.attachmentKey),
        new TextEncoder().encode("thumb"),
      );
      storage.objects.set(fixture.exportKey, new TextEncoder().encode("zip"));
      for (const variant of ["lg", "md", "sm"] as const) {
        storage.objects.set(
          avatarKey(fixture.memberId, fixture.avatarHash, variant),
          new TextEncoder().encode("avatar"),
        );
        storage.objects.set(
          avatarKey(fixture.memberId, "e".repeat(64), variant),
          new TextEncoder().encode("old avatar"),
        );
      }
      await database.sql`
        INSERT INTO core.avatar_deletions (member_id, avatar_hash)
        VALUES (${fixture.memberId}, ${"e".repeat(64)})
      `;
      const [message] = (await database.sql`
        SELECT id::text AS id FROM core.conversation_messages WHERE author_id = ${fixture.memberId}
      `) as Array<{ id: string }>;
      await database.sql`
        INSERT INTO core.quote_snapshots (
          source_kind, source_id, source_author_id, body_md, body_html,
          render_version, sanitiser_version
        ) VALUES (
          'message', ${message?.id}, ${fixture.memberId}, 'Private quote text',
          '<p>Private quote text</p>', 3_000_000, 1
        )
      `;
      const request = await requestDataErasure(database.sql, fixture.token, fixture.memberId);

      if (request === null) {
        throw new Error("erasure request was not created");
      }

      await approveErasure(database, fixture, request.requestId);

      const [memberState] = (await database.sql`
        SELECT state FROM core.members WHERE id = ${fixture.memberId}
      `) as Array<{ state: string }>;
      expect(memberState?.state).toBe("erasing");

      const [session] = (await database.sql`
        SELECT revoked_at FROM core.sessions WHERE id = ${fixture.sessionId}
      `) as Array<{ revoked_at: Date | null }>;
      expect(session?.revoked_at).not.toBeNull();

      const [apiKey] = (await database.sql`
        SELECT revoked_at FROM core.api_keys WHERE id = ${fixture.apiKeyId}
      `) as Array<{ revoked_at: Date | null }>;
      expect(apiKey?.revoked_at).not.toBeNull();

      const push = (await database.sql`
        SELECT id FROM pii.push_subscriptions WHERE member_id = ${fixture.memberId}
      `) as unknown[];
      expect(push).toHaveLength(0);

      const [fence] = (await database.sql`
        SELECT session_ids::text[] AS sessions, api_key_ids::text[] AS keys,
          push_device_ids::text[] AS devices
        FROM pii.erasure_fences WHERE request_id = ${request.requestId}
      `) as Array<{ sessions: string[]; keys: string[]; devices: string[] }>;
      expect(fence?.sessions).toContain(fixture.sessionId);
      expect(fence?.keys).toContain(fixture.apiKeyId);
      expect(fence?.devices).toContain(fixture.pushDeviceId);

      const [{ count: accepted }] = (await database.sql`
        SELECT count(*)::int AS count FROM core.events WHERE type = 'privacy.erasure.accepted'
      `) as Array<{ count: number }>;
      expect(accepted).toBe(1);

      await withRole(database, "user_api", async (sql) => {
        const [row] = (await sql`
          SELECT pii.resolve_identity(
            'https://auth.test', 'erase-alice', 'alice@example.test', 'Alice Original'
          ) AS id
        `) as Array<{ id: string | null }>;
        expect(row?.id).toBeNull();
      });

      const [intent] = (await database.sql`
        SELECT id::text AS id FROM core.delivery_intents
        WHERE member_id = ${fixture.memberId} LIMIT 1
      `) as Array<{ id: string }>;
      if (intent !== undefined) {
        const [target] = (await database.sql`
          SELECT pii.delivery_target(${intent.id}, 'email') AS email
        `) as Array<{ email: string | null }>;
        expect(target?.email).toBeNull();
      }

      const [pendingExport] = (await database.sql`
        INSERT INTO pii.data_requests (member_id, kind, status)
        VALUES (${fixture.memberId}, 'export', 'pending')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [blockedExport] = (await database.sql`
        SELECT pii.begin_export(${pendingExport?.id}) AS member_id
      `) as Array<{ member_id: string | null }>;
      expect(blockedExport?.member_id).toBeNull();

      const pluginCalls: string[] = [];
      const result = await runErasureJob(database.sql, storage.storage, request.requestId, {
        pluginErase: async (pluginId) => {
          pluginCalls.push(pluginId);
          return { ok: true };
        },
      });
      expect(result?.memberId).toBe(fixture.memberId);
      expect(result?.postAction).toBe("anonymise");
      expect(result?.steps).toEqual(ERASURE_STEPS);
      expect(pluginCalls).toEqual(["sample-plugin"]);

      const [pluginRequest] = (await database.sql`
        SELECT status, completed_at FROM core.plugin_gdpr_requests
        WHERE plugin_id = 'sample-plugin' AND kind = 'erase' AND member_id = ${fixture.memberId}
      `) as Array<{ status: string; completed_at: Date | null }>;
      expect(pluginRequest?.status).toBe("completed");
      expect(pluginRequest?.completed_at).not.toBeNull();

      const [erased] = (await database.sql`
        SELECT state, display_name, locale, about_md, signature_md, custom_title, avatar_hash,
          hide_online, hide_from_member_list, reputation, post_count
        FROM core.members WHERE id = ${fixture.memberId}
      `) as Array<Record<string, unknown>>;
      expect(erased).toMatchObject({
        state: "erased",
        display_name: `Deleted member #${fixture.memberId}`,
        locale: null,
        about_md: "",
        signature_md: "",
        custom_title: null,
        avatar_hash: null,
        hide_online: true,
        hide_from_member_list: true,
        reputation: 0,
        post_count: 0,
      });

      const restrictedCounts = (await database.sql`
        SELECT
          (SELECT count(*)::int FROM pii.identities WHERE member_id = ${fixture.memberId}) AS identities,
          (SELECT count(*)::int FROM pii.ip_log WHERE member_id = ${fixture.memberId}) AS ip_logs,
          (SELECT count(*)::int FROM pii.post_ips WHERE member_id = ${fixture.memberId}) AS post_ips,
          (SELECT count(*)::int FROM pii.push_subscriptions WHERE member_id = ${fixture.memberId}) AS push,
          (SELECT count(*)::int FROM pii.access_grants WHERE actor_member_id = ${fixture.memberId}) AS grants,
          (SELECT count(*)::int FROM core.sessions WHERE member_id = ${fixture.memberId}) AS sessions,
          (SELECT count(*)::int FROM pii.data_requests WHERE member_id = ${fixture.memberId}) AS requests,
          (SELECT count(*)::int FROM pii.access_log WHERE subject_member_id = ${fixture.memberId}) AS access_log
      `) as Array<Record<string, number>>;
      expect(restrictedCounts[0]).toMatchObject({
        identities: 0,
        ip_logs: 0,
        post_ips: 0,
        push: 0,
        grants: 0,
        sessions: 0,
      });
      expect(restrictedCounts[0]?.requests).toBe(3);
      expect(restrictedCounts[0]?.access_log).toBeGreaterThan(0);

      const counts = (await database.sql`
        SELECT
          (SELECT count(*)::int FROM core.member_groups WHERE member_id = ${fixture.memberId}) AS groups,
          (SELECT count(*)::int FROM core.member_name_history WHERE member_id = ${fixture.memberId}) AS names,
          (SELECT count(*)::int FROM core.slug_history WHERE kind = 'profile' AND resource_id = ${fixture.memberId}) AS slugs,
          (SELECT count(*)::int FROM core.member_field_values WHERE member_id = ${fixture.memberId}) AS fields,
          (SELECT count(*)::int FROM core.member_badges WHERE member_id = ${fixture.memberId}) AS badges,
          (SELECT count(*)::int FROM core.followed_topics WHERE member_id = ${fixture.memberId}) AS followed_topics,
          (SELECT count(*)::int FROM core.friendships WHERE a_member_id = ${fixture.memberId} OR b_member_id = ${fixture.memberId}) AS friendships,
          (SELECT count(*)::int FROM core.member_ignores WHERE member_id = ${fixture.memberId} OR ignored_id = ${fixture.memberId}) AS ignores,
          (SELECT count(*)::int FROM core.drafts WHERE member_id = ${fixture.memberId}) AS drafts,
          (SELECT count(*)::int FROM core.poll_votes WHERE member_id = ${fixture.memberId}) AS poll_votes,
          (SELECT count(*)::int FROM core.poll_vote_choices WHERE member_id = ${fixture.memberId}) AS poll_choices,
          (SELECT count(*)::int FROM core.post_reactions WHERE member_id = ${fixture.memberId}) AS reactions,
          (SELECT count(*)::int FROM core.reputation_entries WHERE giver_id = ${fixture.memberId} OR receiver_id = ${fixture.memberId}) AS reputation,
          (SELECT count(*)::int FROM core.notifications WHERE member_id = ${fixture.memberId}) AS notifications,
          (SELECT count(*)::int FROM core.notification_preferences WHERE member_id = ${fixture.memberId}) AS preferences,
          (SELECT count(*)::int FROM core.digest_subscriptions WHERE member_id = ${fixture.memberId}) AS digests,
          (SELECT count(*)::int FROM core.delivery_intents WHERE member_id = ${fixture.memberId}) AS intents,
          (SELECT count(*)::int FROM core.api_keys WHERE principal_member_id = ${fixture.memberId}) AS keys,
          (SELECT count(*)::int FROM core.attachments WHERE member_id = ${fixture.memberId}) AS attachments,
          (SELECT count(*)::int FROM core.post_revisions WHERE editor_id = ${fixture.memberId}) AS revisions,
          (SELECT count(*)::int FROM core.conversation_messages WHERE author_id = ${fixture.memberId}) AS messages,
          (SELECT count(*)::int FROM core.conversation_participants WHERE member_id = ${fixture.memberId}) AS participants,
          (SELECT count(*)::int FROM core.member_restrictions WHERE member_id = ${fixture.memberId}) AS restrictions,
          (SELECT count(*)::int FROM core.leaderboard_entries WHERE member_id = ${fixture.memberId}) AS leaderboard,
          (SELECT count(*)::int FROM core.moderators WHERE member_id = ${fixture.memberId}) AS moderators,
          (SELECT count(*)::int FROM core.forum_reads WHERE member_id = ${fixture.memberId}) AS forum_reads,
          (SELECT count(*)::int FROM core.topic_reads WHERE member_id = ${fixture.memberId}) AS topic_reads,
          (SELECT count(*)::int FROM core.announcement_dismissals WHERE member_id = ${fixture.memberId}) AS dismissals,
          (SELECT count(*)::int FROM core.conversation_daily_starts WHERE member_id = ${fixture.memberId}) AS daily_starts,
          (SELECT count(*)::int FROM core.report_reporters WHERE reporter_id = ${fixture.memberId}) AS reporters,
          (SELECT count(*)::int FROM core.report_comments WHERE actor_id = ${fixture.memberId}) AS comments,
          (SELECT count(*)::int FROM core.warnings WHERE member_id = ${fixture.memberId}) AS warnings
      `) as Array<Record<string, number>>;
      expect(counts[0]).toMatchObject({
        groups: 0,
        names: 0,
        slugs: 0,
        fields: 0,
        badges: 0,
        followed_topics: 0,
        friendships: 0,
        ignores: 0,
        drafts: 0,
        poll_votes: 0,
        poll_choices: 0,
        reactions: 0,
        reputation: 0,
        notifications: 0,
        preferences: 0,
        digests: 0,
        intents: 0,
        keys: 0,
        attachments: 0,
        revisions: 0,
        messages: 0,
        participants: 0,
        restrictions: 0,
        leaderboard: 0,
        moderators: 0,
        forum_reads: 0,
        topic_reads: 0,
        dismissals: 0,
        daily_starts: 0,
        reporters: 0,
        comments: 0,
        warnings: 1,
      });

      const [actor] = (await database.sql`
        SELECT actor_id::text AS actor_id FROM core.notifications WHERE member_id = ${fixture.otherId} LIMIT 1
      `) as Array<{ actor_id: string | null }>;
      expect(actor?.actor_id).toBeNull();

      const posts = (await database.sql`
        SELECT id::text AS id, author_id::text AS author_id, body_md
        FROM core.posts WHERE topic_id = ${fixture.topicId} ORDER BY id
      `) as Array<{ id: string; author_id: string; body_md: string }>;
      expect(posts.map((post) => post.id).sort()).toEqual(
        [fixture.postId, fixture.mentionPostId].sort(),
      );
      expect(posts.find((post) => post.id === fixture.mentionPostId)?.body_md).toContain(
        `@Deleted member #${fixture.memberId}`,
      );
      expect(posts.find((post) => post.id === fixture.mentionPostId)?.body_md).not.toContain(
        "Alice Original",
      );
      expect(posts.find((post) => post.id === fixture.mentionPostId)?.body_md).not.toContain(
        "Alice Old",
      );
      const [mentionHtml] = (await database.sql`
        SELECT body_html FROM core.posts WHERE id = ${fixture.mentionPostId}
      `) as Array<{ body_html: string }>;
      expect(mentionHtml?.body_html).not.toContain("Alice Original");
      expect(mentionHtml?.body_html).not.toContain("Alice Old");

      const [snapshot] = (await database.sql`
        SELECT body_md, body_html, redacted_at FROM core.quote_snapshots WHERE source_id = ${fixture.postId}
      `) as Array<{ body_md: string; body_html: string; redacted_at: Date | null }>;
      expect(snapshot?.body_md).toBe("");
      expect(snapshot?.body_html).toBe("");
      expect(snapshot?.redacted_at).not.toBeNull();
      const [privateSnapshots] = (await database.sql`
        SELECT count(*)::int AS count FROM core.quote_snapshots
        WHERE source_kind = 'message' AND source_author_id = ${fixture.memberId}
      `) as Array<{ count: number }>;
      expect(privateSnapshots?.count).toBe(0);

      expect(storage.deleted).toContain(fixture.attachmentKey);
      expect(storage.deleted).toContain(thumbnailKeyFor(fixture.attachmentKey));
      expect(storage.deleted).toContain(avatarKey(fixture.memberId, fixture.avatarHash, "lg"));
      expect(storage.deleted).toContain(avatarKey(fixture.memberId, "e".repeat(64), "lg"));
      expect(storage.deleted).toContain(fixture.exportKey);

      const journalKeys = [...storage.objects.keys()].filter((key) =>
        key.startsWith(fixture.journalPrefix),
      );
      expect(journalKeys).toHaveLength(1);
      const journal = JSON.parse(
        new TextDecoder().decode(storage.objects.get(journalKeys[0] ?? "")),
      ) as Record<string, unknown>;
      expect(journal).toMatchObject({ requestId: request.requestId, memberId: fixture.memberId });
      expect(journal.sessionIds).toContain(fixture.sessionId);
      expect(journal.apiKeyIds).toContain(fixture.apiKeyId);
      expect(journal.pushDeviceIds).toContain(fixture.pushDeviceId);

      const [requestState] = (await database.sql`
        SELECT status, completed_at FROM pii.data_requests WHERE id = ${request.requestId}
      `) as Array<{ status: string; completed_at: Date | null }>;
      expect(requestState?.status).toBe("completed");
      expect(requestState?.completed_at).not.toBeNull();
    });
  }, 120_000);

  test("retries a failed plugin step without duplicating completed steps", async () => {
    await withDb("privacy_erasure_retry", async (database) => {
      const fixture = await createFixtures(database);
      const storage = createStorage();
      storage.objects.set(fixture.attachmentKey, new TextEncoder().encode("erase!"));
      const request = await requestDataErasure(database.sql, fixture.token, fixture.memberId);

      if (request === null) {
        throw new Error("erasure request was not created");
      }

      await approveErasure(database, fixture, request.requestId);

      await expect(
        runErasureJob(database.sql, storage.storage, request.requestId, {
          pluginErase: async () => ({ ok: false, error: "plugin down" }),
        }),
      ).rejects.toThrow(/plugin down/);

      const [failed] = (await database.sql`
        SELECT state FROM pii.data_request_steps
        WHERE request_id = ${request.requestId} AND step = 'plugin_erase'
      `) as Array<{ state: string }>;
      expect(failed?.state).toBe("failed");

      const [stillErasing] = (await database.sql`
        SELECT state FROM core.members WHERE id = ${fixture.memberId}
      `) as Array<{ state: string }>;
      expect(stillErasing?.state).toBe("erasing");

      const result = await runErasureJob(database.sql, storage.storage, request.requestId, {
        pluginErase: async () => ({ ok: true }),
      });
      expect(result?.memberId).toBe(fixture.memberId);

      const steps = (await database.sql`
        SELECT step, state FROM pii.data_request_steps WHERE request_id = ${request.requestId}
      `) as Array<{ step: string; state: string }>;
      expect(steps).toHaveLength(ERASURE_STEPS.length);
      expect(steps.every((step) => step.state === "completed")).toBe(true);

      const [completed] = (await database.sql`
        SELECT status FROM pii.data_requests WHERE id = ${request.requestId}
      `) as Array<{ status: string }>;
      expect(completed?.status).toBe("completed");
    });
  }, 120_000);

  test("rejects a member write that races the erasure fence", async () => {
    await withDb("privacy_erasure_write_fence", async (database) => {
      const fixture = await createFixtures(database);
      const request = await requestDataErasure(database.sql, fixture.token, fixture.memberId);

      if (request === null) {
        throw new Error("erasure request was not created");
      }

      await approveErasure(database, fixture, request.requestId);
      const memberApi = new SQL(roleUrl(database, "user_api"));

      try {
        await expect(
          saveDraft(memberApi, fixture.memberId, "new-topic:1", "recreated after the fence"),
        ).rejects.toThrow(/not active/);
      } finally {
        await memberApi.close();
      }

      const drafts = (await database.sql`
        SELECT count(*)::int AS count FROM core.drafts
        WHERE member_id = ${fixture.memberId} AND body_md = 'recreated after the fence'
      `) as Array<{ count: number }>;
      expect(drafts[0]?.count).toBe(0);
    });
  }, 60_000);

  test("retains attachment and avatar work until storage confirms deletion", async () => {
    await withDb("privacy_erasure_storage_retry", async (database) => {
      const fixture = await createFixtures(database);
      const storage = createStorage();
      storage.objects.set(fixture.attachmentKey, new TextEncoder().encode("erase!"));
      storage.objects.set(
        thumbnailKeyFor(fixture.attachmentKey),
        new TextEncoder().encode("thumb"),
      );
      for (const variant of ["lg", "md", "sm"] as const) {
        storage.objects.set(
          avatarKey(fixture.memberId, fixture.avatarHash, variant),
          new TextEncoder().encode("avatar"),
        );
      }
      storage.failing.add(fixture.attachmentKey);
      const request = await requestDataErasure(database.sql, fixture.token, fixture.memberId);

      if (request === null) {
        throw new Error("erasure request was not created");
      }

      await approveErasure(database, fixture, request.requestId);
      await expect(
        runErasureJob(database.sql, storage.storage, request.requestId, {
          pluginErase: async () => ({ ok: true }),
        }),
      ).rejects.toThrow(/storage unavailable/);

      const [attachment] = (await database.sql`
        SELECT count(*)::int AS count FROM core.attachments WHERE member_id = ${fixture.memberId}
      `) as Array<{ count: number }>;
      expect(attachment?.count).toBe(1);
      const [failed] = (await database.sql`
        SELECT state FROM pii.data_request_steps
        WHERE request_id = ${request.requestId} AND step = 'attachments'
      `) as Array<{ state: string }>;
      expect(failed?.state).toBe("failed");

      storage.failing.clear();
      storage.failing.add(avatarKey(fixture.memberId, fixture.avatarHash, "md"));
      await expect(
        runErasureJob(database.sql, storage.storage, request.requestId, {
          pluginErase: async () => ({ ok: true }),
        }),
      ).rejects.toThrow(/storage unavailable/);

      storage.failing.clear();
      const completed = await runErasureJob(database.sql, storage.storage, request.requestId, {
        pluginErase: async () => ({ ok: true }),
      });
      expect(completed?.memberId).toBe(fixture.memberId);
      const [remaining] = (await database.sql`
        SELECT count(*)::int AS count FROM core.attachments WHERE member_id = ${fixture.memberId}
      `) as Array<{ count: number }>;
      expect(remaining?.count).toBe(0);
      expect(storage.deleted).toContain(fixture.attachmentKey);
      expect(storage.deleted).toContain(avatarKey(fixture.memberId, fixture.avatarHash, "lg"));
      expect(storage.deleted).toContain(avatarKey(fixture.memberId, fixture.avatarHash, "md"));
    });
  }, 120_000);

  test("retains export keys until the archive object is deleted", async () => {
    await withDb("privacy_erasure_export_retry", async (database) => {
      const fixture = await createFixtures(database);
      const storage = createStorage();
      storage.objects.set(fixture.exportKey, new TextEncoder().encode("zip"));
      storage.failing.add(fixture.exportKey);
      const request = await requestDataErasure(database.sql, fixture.token, fixture.memberId);

      if (request === null) {
        throw new Error("erasure request was not created");
      }

      await approveErasure(database, fixture, request.requestId);
      await expect(
        runErasureJob(database.sql, storage.storage, request.requestId, {
          pluginErase: async () => ({ ok: true }),
        }),
      ).rejects.toThrow(/storage unavailable/);

      const [row] = (await database.sql`
        SELECT export_key FROM pii.data_requests
        WHERE member_id = ${fixture.memberId} AND export_key IS NOT NULL
      `) as Array<{ export_key: string }>;
      expect(row?.export_key).toBe(fixture.exportKey);

      storage.failing.clear();
      const completed = await runErasureJob(database.sql, storage.storage, request.requestId, {
        pluginErase: async () => ({ ok: true }),
      });
      expect(completed?.memberId).toBe(fixture.memberId);
      expect(storage.deleted).toContain(fixture.exportKey);
    });
  }, 120_000);

  test("keeps captured names when erasure resumes after anonymisation", async () => {
    await withDb("privacy_erasure_names", async (database) => {
      const fixture = await createFixtures(database);
      const storage = createStorage();
      const request = await requestDataErasure(database.sql, fixture.token, fixture.memberId);

      if (request === null) {
        throw new Error("erasure request was not created");
      }

      await approveErasure(database, fixture, request.requestId);
      await database.sql`
        INSERT INTO core.job_cursors (subscriber, last_event_id)
        VALUES (${rerenderCursorKey("posts", currentContentVersions())}, 999999)
      `;
      await database.sql`DELETE FROM core.member_name_history WHERE member_id = ${fixture.memberId}`;
      await database.sql`
        UPDATE core.members SET display_name = 'Changed Later' WHERE id = ${fixture.memberId}
      `;

      const completed = await runErasureJob(database.sql, storage.storage, request.requestId, {
        pluginErase: async () => ({ ok: true }),
      });
      expect(completed?.memberId).toBe(fixture.memberId);
      const [post] = (await database.sql`
        SELECT body_md FROM core.posts WHERE id = ${fixture.mentionPostId}
      `) as Array<{ body_md: string }>;
      expect(post?.body_md).toBe(
        `Hello @Deleted member #${fixture.memberId} and @Deleted member #${fixture.memberId}`,
      );
      expect(post?.body_md).not.toContain("Alice Original");
      expect(post?.body_md).not.toContain("Alice Old");
      expect(post?.body_md).not.toContain("Changed Later");
    });
  }, 120_000);

  test("cancels an export that begins before the erasure fence", async () => {
    await withDb("privacy_erasure_export_fence", async (database) => {
      const fixture = await createFixtures(database);
      const storage = createStorage();
      const exportRequest = await requestDataExport(database.sql, fixture.token, fixture.memberId);

      if (exportRequest === null) {
        throw new Error("export request was not created");
      }

      const [begun] = (await database.sql`
        SELECT pii.begin_export(${exportRequest}) AS member_id
      `) as Array<{ member_id: string | null }>;
      expect(begun?.member_id).toBe(fixture.memberId);

      const erasure = await requestDataErasure(database.sql, fixture.token, fixture.memberId);

      if (erasure === null) {
        throw new Error("erasure request was not created");
      }

      await approveErasure(database, fixture, erasure.requestId);

      const [cancelled] = (await database.sql`
        SELECT status FROM pii.data_requests WHERE id = ${exportRequest}
      `) as Array<{ status: string }>;
      expect(cancelled?.status).toBe("cancelled");

      const [completed] = (await database.sql`
        SELECT pii.complete_export(${exportRequest}, 'export/late.zip', now() + interval '7 days') AS ok
      `) as Array<{ ok: boolean }>;
      expect(completed?.ok).toBe(false);

      const late = await runExportJob(database.sql, storage.storage, exportRequest, {
        pluginExport: async () => ({ ok: true, data: {} }),
      });
      expect(late).toBeNull();

      const [notified] = (await database.sql`
        SELECT count(*)::int AS count FROM core.notifications
        WHERE data_request_id = ${exportRequest}
      `) as Array<{ count: number }>;
      expect(notified?.count).toBe(0);
    });
  }, 120_000);

  test("makes journal keys unique per request and stable across retries", () => {
    const accepted = new Date("2026-01-02T03:04:05Z");
    expect(journalKeyFor("7", accepted)).toBe(journalKeyFor("7", accepted));
    expect(new Set([journalKeyFor("7", accepted), journalKeyFor("8", accepted)]).size).toBe(2);
  });

  test("can delete posts instead of keeping them anonymised", async () => {
    await withDb("privacy_erasure_delete_posts", async (database) => {
      const fixture = await createFixtures(database);
      const storage = createStorage();
      storage.objects.set(fixture.attachmentKey, new TextEncoder().encode("erase!"));
      const request = await requestDataErasure(database.sql, fixture.token, fixture.memberId);

      if (request === null) {
        throw new Error("erasure request was not created");
      }

      await database.sql`
        UPDATE pii.data_requests SET post_action = 'delete' WHERE id = ${request.requestId}
      `;
      await approveErasure(database, fixture, request.requestId);
      const postVersion = await readTagVersion(database.sql, postTag(fixture.postId));
      const topicVersion = await readTagVersion(database.sql, topicTag(fixture.topicId));
      const result = await runErasureJob(database.sql, storage.storage, request.requestId, {
        pluginErase: async () => ({ ok: true }),
      });

      expect(result?.postAction).toBe("delete");
      expect(result?.deletedPosts).toBe(1);
      expect(Number(await readTagVersion(database.sql, postTag(fixture.postId)))).toBeGreaterThan(
        Number(postVersion),
      );
      expect(Number(await readTagVersion(database.sql, topicTag(fixture.topicId)))).toBeGreaterThan(
        Number(topicVersion),
      );

      const posts = (await database.sql`
        SELECT id::text AS id FROM core.posts WHERE author_id = ${fixture.memberId}
      `) as Array<{ id: string }>;
      expect(posts).toHaveLength(0);

      const [topic] = (await database.sql`
        SELECT first_post_id, last_post_id, reply_count FROM core.topics WHERE id = ${fixture.topicId}
      `) as Array<{
        first_post_id: string | null;
        last_post_id: string | null;
        reply_count: number;
      }>;
      expect(topic).toMatchObject({
        first_post_id: fixture.mentionPostId,
        last_post_id: fixture.mentionPostId,
        reply_count: 1,
      });
    });
  }, 120_000);
});
