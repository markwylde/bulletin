import {
  bumpCacheTags,
  type CdnPurger,
  forumTag,
  GLOBAL_CACHE_TAGS,
  memberTag,
  postSnapshotsTag,
  postTag,
  topicPagesTag,
  topicTag,
} from "@bulletin/cache";
import type { Logger } from "@bulletin/config";
import { redactQuoteSnapshots } from "@bulletin/domain/content";
import { recomputeReactionSummary } from "@bulletin/domain/reactions";
import { recountTopic, refreshForumLastPost } from "@bulletin/domain/topics";
import { avatarKey, type StorageClient, thumbnailKeyFor } from "@bulletin/storage";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";
import {
  postRerenderSource,
  quoteSnapshotRerenderSource,
  runContentRerenderJob,
} from "./content.ts";
import { runReputationRecount } from "./reputation.ts";

/** Ordered erasure work; each step is idempotent and recorded in data_request_steps. */
export const ERASURE_QUEUE = "privacy.erasure";

export const ERASURE_STEPS = [
  "plugin_erase",
  "quote_snapshots",
  "attachments",
  "posts",
  "poll_votes",
  "reactions",
  "reputation",
  "badges",
  "follows",
  "ignores",
  "friendships",
  "drafts",
  "revisions",
  "conversations",
  "notifications",
  "api_keys",
  "profile_history",
  "export_archives",
  "restricted_data",
  "anonymise_member",
  "mentions_rerender",
  "journal",
] as const;

const AVATAR_VARIANTS = ["lg", "md", "sm"] as const;

export interface ErasurePluginResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface ErasureJobOptions {
  readonly pluginErase?: (pluginId: string, memberId: string) => Promise<ErasurePluginResult>;
  readonly pluginHostUrl?: string;
  readonly pluginToken?: string;
  readonly logger?: Logger;
  readonly now?: Date;
  readonly purge?: CdnPurger;
}

export interface ErasureResult {
  readonly requestId: string;
  readonly memberId: string;
  readonly postAction: "anonymise" | "delete";
  readonly steps: readonly string[];
  readonly deletedPosts: number;
  readonly deletedAttachments: number;
  readonly journalKey: string;
}

interface ErasureStart {
  readonly memberId: string;
  readonly postAction: "anonymise" | "delete";
  readonly oldNames: readonly string[];
  readonly sessionIds: readonly string[];
  readonly apiKeyIds: readonly string[];
  readonly pushDeviceIds: readonly string[];
}

function strings(value: unknown): string[] {
  let parsed = value;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return [];
    }
  }

  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function start(value: unknown): ErasureStart | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const memberId = typeof record.memberId === "string" ? record.memberId : "";
  const postAction = record.postAction === "delete" ? "delete" : "anonymise";

  if (!/^\d+$/.test(memberId)) {
    return null;
  }

  return {
    memberId,
    postAction,
    oldNames: strings(record.oldNames),
    sessionIds: strings(record.sessionIds),
    apiKeyIds: strings(record.apiKeyIds),
    pushDeviceIds: strings(record.pushDeviceIds),
  };
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pluginEraser(options: ErasureJobOptions) {
  if (options.pluginErase !== undefined) {
    return options.pluginErase;
  }

  return async (pluginId: string, memberId: string): Promise<ErasurePluginResult> => {
    if (options.pluginHostUrl === undefined || options.pluginToken === undefined) {
      return { ok: false, error: "plugin host is not configured" };
    }

    try {
      const response = await fetch(`${options.pluginHostUrl}/internal/gdpr`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.pluginToken}`,
        },
        body: JSON.stringify({ pluginId, operation: "erase", memberId }),
      });
      const body = (await response.json().catch(() => null)) as {
        readonly ok?: unknown;
        readonly error?: unknown;
      } | null;

      return {
        ok: response.ok && body?.ok === true,
        ...(typeof body?.error === "string"
          ? { error: body.error }
          : response.ok
            ? {}
            : { error: `plugin host answered ${response.status}` }),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

async function runStep(
  sql: SQL,
  requestId: string,
  step: string,
  completed: Set<string>,
  run: () => Promise<void>,
): Promise<void> {
  if (completed.has(step)) {
    return;
  }

  await sql`SELECT pii.update_request_step(${requestId}, ${step}, 'running')`;

  try {
    await run();
  } catch (error) {
    await sql`SELECT pii.update_request_step(${requestId}, ${step}, 'failed')`;
    throw error;
  }

  await sql`SELECT pii.update_request_step(${requestId}, ${step}, 'completed')`;
}

async function deleteObject(storage: StorageClient, key: string): Promise<void> {
  if (!(await storage.exists(key))) {
    return;
  }

  await storage.delete(key);
}

async function deleteAttachmentObjects(
  storage: StorageClient,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    await deleteObject(storage, key);
    if (key.startsWith("att/")) {
      await deleteObject(storage, thumbnailKeyFor(key));
    }
  }
}

/** Request IDs are unique and retries use the fence date, so this key is collision-safe and
 * idempotent across worker replicas. */
export function journalKeyFor(requestId: string, acceptedAt: Date): string {
  return `journal/${acceptedAt.toISOString().slice(0, 10)}/${requestId.padStart(12, "0")}.json`;
}

/** Runs one erasure request; retries skip every step already marked completed. */
export async function runErasureJob(
  sql: SQL,
  storage: StorageClient,
  requestId: string,
  options: ErasureJobOptions = {},
): Promise<ErasureResult | null> {
  const [begun] = (await sql`
    SELECT pii.begin_erasure(${requestId}) AS start
  `) as Array<{ start: unknown }>;
  const info = start(begun?.start);

  if (info === null) {
    return null;
  }

  const memberId = info.memberId;
  const [member] = (await sql`
    SELECT display_name FROM core.members WHERE id = ${memberId}
  `) as Array<{ display_name: string | null }>;
  const [history] = (await sql`
    SELECT COALESCE(array_agg(old_name), '{}'::text[]) AS names
    FROM core.member_name_history
    WHERE member_id = ${memberId}
  `) as Array<{ names: string[] }>;
  const completedRows = (await sql`
    SELECT step FROM pii.request_step_states(${requestId}) WHERE state = 'completed'
  `) as Array<{ step: string }>;
  const completed = new Set(completedRows.map((row) => row.step));
  const oldNames =
    info.oldNames.length > 0
      ? [...info.oldNames]
      : [
          ...new Set(
            [member?.display_name ?? "", ...(history?.names ?? [])].filter(
              (name) => name.trim() !== "",
            ),
          ),
        ];
  const newName = `Deleted member #${memberId}`;
  const now = options.now ?? new Date();
  const eraser = pluginEraser(options);
  let deletedPosts = 0;
  let deletedAttachments = 0;
  let journalKey = "";

  await runStep(sql, requestId, "plugin_erase", completed, async () => {
    const plugins = (await sql`
      SELECT DISTINCT plugin_id FROM core.plugin_personal_data ORDER BY plugin_id
    `) as Array<{ plugin_id: string }>;

    for (const plugin of plugins) {
      const result = await eraser(plugin.plugin_id, memberId);

      if (!result.ok) {
        await sql`
          INSERT INTO core.plugin_gdpr_requests (plugin_id, kind, member_id, status, error)
          VALUES (
            ${plugin.plugin_id}, 'erase', ${memberId}, 'failed',
            ${result.error ?? "handler failed"}
          )
        `;
        throw new Error(
          `Plugin ${plugin.plugin_id} did not complete erasure: ${result.error ?? "unknown error"}`,
        );
      }

      await sql`
        INSERT INTO core.plugin_gdpr_requests (
          plugin_id, kind, member_id, status, completed_at
        ) VALUES (
          ${plugin.plugin_id}, 'erase', ${memberId}, 'completed', now()
        )
      `;
    }
  });

  await runStep(sql, requestId, "quote_snapshots", completed, async () => {
    const posts = (await sql`
      SELECT id::text AS id FROM core.posts WHERE author_id = ${memberId}
    `) as Array<{ id: string }>;
    const messages = (await sql`
      SELECT id::text AS id FROM core.conversation_messages WHERE author_id = ${memberId}
    `) as Array<{ id: string }>;

    for (const post of posts) {
      await redactQuoteSnapshots(sql, { kind: "post", id: post.id });
    }

    if (posts.length > 0) {
      await sql`
        UPDATE core.quote_snapshots
        SET body_md = '', body_html = '', redacted_at = COALESCE(redacted_at, now())
        WHERE source_kind = 'post'
          AND source_id = ANY(${`{${posts.map((post) => post.id).join(",")}}`}::bigint[])
      `;
      await bumpCacheTags(
        sql,
        posts.map((post) => postSnapshotsTag(post.id)),
      );
    }

    if (messages.length > 0) {
      await sql`
        DELETE FROM core.quote_snapshots
        WHERE source_kind = 'message'
          AND (
            source_author_id = ${memberId}
            OR source_id = ANY(${`{${messages.map((message) => message.id).join(",")}}`}::bigint[])
          )
      `;
    }
  });

  await runStep(sql, requestId, "attachments", completed, async () => {
    const [avatar] = (await sql`
      SELECT avatar_hash FROM core.members WHERE id = ${memberId}
    `) as Array<{ avatar_hash: string | null }>;
    const queuedAvatars = (await sql`
      SELECT avatar_hash FROM core.avatar_deletions WHERE member_id = ${memberId}
    `) as Array<{ avatar_hash: string }>;
    const avatarHashes = new Set([
      ...(avatar?.avatar_hash === null || avatar?.avatar_hash === undefined
        ? []
        : [avatar.avatar_hash]),
      ...queuedAvatars.map((row) => row.avatar_hash),
    ]);
    const attachments = (await sql`
      SELECT quarantine_key, snapshot_key, storage_key
      FROM core.attachments WHERE member_id = ${memberId}
    `) as Array<{
      quarantine_key: string;
      snapshot_key: string | null;
      storage_key: string | null;
    }>;
    const keys = attachments.flatMap((attachment) => [
      attachment.quarantine_key,
      ...(attachment.snapshot_key === null ? [] : [attachment.snapshot_key]),
      ...(attachment.storage_key === null ? [] : [attachment.storage_key]),
    ]);

    await deleteAttachmentObjects(storage, keys);

    for (const hash of avatarHashes) {
      for (const variant of AVATAR_VARIANTS) {
        await deleteObject(storage, avatarKey(memberId, hash, variant));
      }
    }

    if (attachments.length > 0) {
      await sql`DELETE FROM core.attachments WHERE member_id = ${memberId}`;
    }

    await sql`DELETE FROM core.avatar_deletions WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.member_storage WHERE member_id = ${memberId}`;
    deletedAttachments = attachments.length;
  });

  await runStep(sql, requestId, "posts", completed, async () => {
    await sql.begin(async (tx) => {
      const posts = (await tx`
        SELECT p.id::text AS id, p.topic_id::text AS topic_id, t.forum_id::text AS forum_id
        FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
        WHERE p.author_id = ${memberId}
      `) as Array<{ id: string; topic_id: string; forum_id: string }>;
      deletedPosts = posts.length;

      if (info.postAction === "delete") {
        await tx`DELETE FROM core.posts WHERE author_id = ${memberId}`;

        for (const topicId of new Set(posts.map((post) => post.topic_id))) {
          await recountTopic(tx, topicId);
        }

        for (const forumId of new Set(posts.map((post) => post.forum_id))) {
          await refreshForumLastPost(tx, forumId);
        }

        const byForum = new Map<string, number>();
        for (const post of posts) {
          byForum.set(post.forum_id, (byForum.get(post.forum_id) ?? 0) + 1);
        }

        for (const [forumId, count] of byForum) {
          await tx`
            UPDATE core.forums
            SET post_count = GREATEST(0, post_count - ${count}), updated_at = now()
            WHERE id = ${forumId}
          `;
        }
      } else {
        await tx`
          UPDATE core.posts SET edited_by = NULL
          WHERE author_id = ${memberId} AND edited_by = ${memberId}
        `;
      }

      await tx`
        DELETE FROM core.post_revisions
        WHERE editor_id = ${memberId}
           OR post_id IN (SELECT id FROM core.posts WHERE author_id = ${memberId})
      `;
      const tags = [
        ...posts.map((post) => postTag(post.id)),
        ...[...new Set(posts.map((post) => post.topic_id))].map(topicTag),
        ...[...new Set(posts.map((post) => post.topic_id))].map(topicPagesTag),
        ...[...new Set(posts.map((post) => post.forum_id))].map(forumTag),
      ];

      if (tags.length > 0) {
        await bumpCacheTags(tx, tags);
      }
    });
  });

  await runStep(sql, requestId, "poll_votes", completed, async () => {
    await sql`DELETE FROM core.poll_vote_choices WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.poll_votes WHERE member_id = ${memberId}`;
  });

  await runStep(sql, requestId, "reactions", completed, async () => {
    const posts = (await sql`
      SELECT DISTINCT post_id::text AS post_id
      FROM core.post_reactions WHERE member_id = ${memberId}
    `) as Array<{ post_id: string }>;

    await sql`DELETE FROM core.post_reactions WHERE member_id = ${memberId}`;

    for (const post of posts) {
      await recomputeReactionSummary(sql, post.post_id);
    }
  });

  await runStep(sql, requestId, "reputation", completed, async () => {
    await sql`
      DELETE FROM core.reputation_entries
      WHERE giver_id = ${memberId} OR receiver_id = ${memberId}
    `;
    await runReputationRecount(sql, { reason: "erasure" });
  });

  await runStep(sql, requestId, "badges", completed, async () => {
    await sql`DELETE FROM core.member_badges WHERE member_id = ${memberId}`;
    await sql`UPDATE core.member_badges SET awarded_by = NULL WHERE awarded_by = ${memberId}`;
  });

  await runStep(sql, requestId, "follows", completed, async () => {
    await sql`
      DELETE FROM core.followed_topics
      WHERE member_id = ${memberId}
    `;
    await sql`DELETE FROM core.followed_forums WHERE member_id = ${memberId}`;
    await sql`
      DELETE FROM core.followed_members
      WHERE follower_id = ${memberId} OR followed_id = ${memberId}
    `;
    await sql`DELETE FROM core.follow_settings WHERE member_id = ${memberId}`;
  });

  await runStep(sql, requestId, "ignores", completed, async () => {
    await sql`
      DELETE FROM core.member_ignores
      WHERE member_id = ${memberId} OR ignored_id = ${memberId}
    `;
  });

  await runStep(sql, requestId, "friendships", completed, async () => {
    await sql`
      DELETE FROM core.friendships
      WHERE a_member_id = ${memberId} OR b_member_id = ${memberId}
         OR requested_by = ${memberId}
    `;
  });

  await runStep(sql, requestId, "drafts", completed, async () => {
    await sql`DELETE FROM core.drafts WHERE member_id = ${memberId}`;
  });

  await runStep(sql, requestId, "revisions", completed, async () => {
    await sql`
      DELETE FROM core.post_revisions
      WHERE editor_id = ${memberId}
         OR post_id IN (SELECT id FROM core.posts WHERE author_id = ${memberId})
    `;
  });

  await runStep(sql, requestId, "conversations", completed, async () => {
    await sql`DELETE FROM core.conversation_messages WHERE author_id = ${memberId}`;
    await sql`DELETE FROM core.conversation_participants WHERE member_id = ${memberId}`;
  });

  await runStep(sql, requestId, "notifications", completed, async () => {
    await sql`DELETE FROM core.notification_actors WHERE actor_id = ${memberId}`;
    await sql`UPDATE core.notifications SET actor_id = NULL WHERE actor_id = ${memberId}`;
    await sql`DELETE FROM core.notifications WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.notification_events WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.notification_preferences WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.digest_deliveries WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.digest_subscriptions WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.delivery_intents WHERE member_id = ${memberId}`;
  });

  await runStep(sql, requestId, "api_keys", completed, async () => {
    await sql`DELETE FROM core.api_keys WHERE principal_member_id = ${memberId}`;
  });

  await runStep(sql, requestId, "profile_history", completed, async () => {
    await sql`DELETE FROM core.member_name_history WHERE member_id = ${memberId}`;
    await sql`
      DELETE FROM core.slug_history
      WHERE kind = 'profile' AND resource_id = ${memberId}
    `;
    await sql`DELETE FROM core.member_field_values WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.member_prefs WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.member_restrictions WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.leaderboard_entries WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.topic_reads WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.forum_reads WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.announcement_dismissals WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.conversation_daily_starts WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.moderators WHERE member_id = ${memberId}`;
    await sql`DELETE FROM core.report_reporters WHERE reporter_id = ${memberId}`;
    await sql`DELETE FROM core.report_comments WHERE actor_id = ${memberId}`;
    await sql`UPDATE core.reports SET assignee_id = NULL WHERE assignee_id = ${memberId}`;
  });

  await runStep(sql, requestId, "export_archives", completed, async () => {
    const [row] = (await sql`
      SELECT pii.erasure_export_keys(${requestId}) AS keys
    `) as Array<{ keys: unknown }>;

    for (const key of strings(row?.keys)) {
      await deleteObject(storage, key);
    }

    await sql`SELECT pii.clear_erasure_export_keys(${requestId})`;
  });

  await runStep(sql, requestId, "restricted_data", completed, async () => {
    await sql`SELECT pii.erase_restricted_data(${requestId})`;
  });

  await runStep(sql, requestId, "anonymise_member", completed, async () => {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM core.member_groups WHERE member_id = ${memberId}`;
      await tx`
      UPDATE core.members
      SET state = 'erased',
          display_name = ${newName},
          name_skeleton = ${`deleted-member-${memberId}`},
          locale = NULL,
          previous_visit_at = NULL,
          last_active_at = NULL,
          board_marked_at = NULL,
          avatar_hash = NULL,
          avatar_updated_at = now(),
          avatar_blocked_until = NULL,
          about_md = '',
          about_html = '',
          signature_md = '',
          signature_html = '',
          signature_updated_at = NULL,
          custom_title = NULL,
          hide_online = true,
          hide_from_member_list = true,
          hide_signatures = false,
          hide_friends = false,
          reputation = 0,
          post_count = 0
      WHERE id = ${memberId}
      `;
      await bumpCacheTags(tx, [
        memberTag(memberId),
        GLOBAL_CACHE_TAGS.directory,
        GLOBAL_CACHE_TAGS.online,
      ]);
    });

    if (options.purge !== undefined) {
      const purged = await options.purge.purge([
        memberTag(memberId),
        GLOBAL_CACHE_TAGS.directory,
        GLOBAL_CACHE_TAGS.online,
      ]);

      if (!purged.ok) {
        throw new Error("CDN purge failed after member anonymisation");
      }
    }
  });

  await runStep(sql, requestId, "mentions_rerender", completed, async () => {
    const patterns = oldNames.map((name) => `@${escapeRegex(name)}`);

    for (const pattern of patterns) {
      await sql`
        UPDATE core.posts
        SET body_md = regexp_replace(body_md, ${pattern}, ${`@${newName}`}, 'gi'),
            render_version = 1
        WHERE (author_id = ${memberId} OR ${memberId} = ANY(mentioned_member_ids))
          AND body_md ~* ${pattern}
      `;
      await sql`
        UPDATE core.quote_snapshots
        SET body_md = regexp_replace(body_md, ${pattern}, ${`@${newName}`}, 'gi'),
            render_version = 1
        WHERE body_md ~* ${pattern}
      `;
    }

    await sql`
      UPDATE core.posts
      SET render_version = 1
      WHERE author_id = ${memberId} OR ${memberId} = ANY(mentioned_member_ids)
    `;

    if (patterns.length > 0) {
      await runContentRerenderJob(sql, {
        sources: [
          { ...quoteSnapshotRerenderSource, name: `quote_snapshots:erasure:${requestId}` },
          { ...postRerenderSource, name: `posts:erasure:${requestId}` },
        ],
      });
    }
  });

  await runStep(sql, requestId, "journal", completed, async () => {
    const [fenceRow] = (await sql`
      SELECT pii.erasure_fence(${requestId}) AS fence
    `) as Array<{ fence: unknown }>;
    const fence =
      typeof fenceRow?.fence === "object" && fenceRow.fence !== null
        ? (fenceRow.fence as Record<string, unknown>)
        : {};
    const acceptedAt = typeof fence.acceptedAt === "string" ? new Date(fence.acceptedAt) : now;
    journalKey = journalKeyFor(requestId, acceptedAt);
    await storage.put(
      journalKey,
      `${JSON.stringify({
        requestId,
        memberId,
        completedAt: now.toISOString(),
        sessionIds: strings(fence.sessionIds),
        apiKeyIds: strings(fence.apiKeyIds),
        pushDeviceIds: strings(fence.pushDeviceIds),
      })}\n`,
      { contentType: "application/json" },
    );
  });

  await sql`SELECT pii.complete_erasure(${requestId})`;

  return {
    requestId,
    memberId,
    postAction: info.postAction,
    steps: ERASURE_STEPS,
    deletedPosts,
    deletedAttachments,
    journalKey,
  };
}

export interface ErasureJobData {
  readonly requestId: string;
}

export interface ErasureJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly storage: StorageClient;
  readonly pluginHostUrl?: string;
  readonly pluginToken?: string;
  readonly logger?: Logger;
  readonly purge?: CdnPurger;
}

export interface ErasureJobs {
  stop(): Promise<void>;
}

export async function createErasureJobs(options: ErasureJobsOptions): Promise<ErasureJobs> {
  await ensurePgBossQueue(options.boss, ERASURE_QUEUE);

  await options.boss.work<ErasureJobData>(ERASURE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const result = await runErasureJob(options.sql, options.storage, job.data.requestId, {
        ...(options.pluginHostUrl === undefined ? {} : { pluginHostUrl: options.pluginHostUrl }),
        ...(options.pluginToken === undefined ? {} : { pluginToken: options.pluginToken }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.purge === undefined ? {} : { purge: options.purge }),
      });

      if (result === null) {
        options.logger?.info("privacy.erasure.skipped", { requestId: job.data.requestId });
      }
    }
  });

  return {
    stop: () => options.boss.offWork(ERASURE_QUEUE),
  };
}
