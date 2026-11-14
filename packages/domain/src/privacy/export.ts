import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import { strToU8, Zip, ZipDeflate } from "fflate";
import { emit } from "../events/outbox.ts";
import { can } from "../permissions/can.ts";
import { loadPermissionSnapshot } from "../permissions/snapshot.ts";
import { loadForumTree } from "../permissions/tree-store.ts";
import { listMemberWarnings } from "../warnings/repository.ts";

/** Plugin export hook result (ADR 0009, ADR 0012). */
export interface PluginExportResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export type PluginExportLoader = (
  pluginId: string,
  memberId: string,
) => Promise<PluginExportResult>;

export interface BuildMemberExportOptions {
  readonly pluginExport?: PluginExportLoader;
  readonly now?: Date;
}

export interface MemberExportBundle {
  /** A temporary zip on disk; the caller must invoke cleanup after upload. */
  readonly path: string;
  readonly cleanup: () => Promise<void>;
  readonly files: readonly string[];
  readonly pluginFailures: readonly string[];
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function safeName(value: string): string {
  const cleaned = value
    .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);

  return cleaned === "" ? "file" : cleaned;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Builds the member's complete export archive in memory (ADR 0012). */
export async function buildMemberExport(
  sql: SQL,
  storage: StorageClient,
  requestId: string,
  options: BuildMemberExportOptions = {},
): Promise<MemberExportBundle> {
  const [restrictedRow] = (await sql`
    SELECT pii.export_member(${requestId}) AS data
  `) as Array<{ data: unknown }>;
  const restricted = asRecord(restrictedRow?.data);

  if (restricted === null) {
    throw new Error(`Export request ${requestId} is not processable`);
  }

  const memberId = typeof restricted.memberId === "string" ? restricted.memberId : "";

  if (!/^\d+$/.test(memberId)) {
    throw new Error(`Export request ${requestId} has no member`);
  }

  const [
    members,
    groups,
    history,
    fields,
    badges,
    prefs,
    notificationPrefs,
    digest,
    followSettings,
    followedTopics,
    followedForums,
    followedMembers,
    posts,
    revisions,
    conversations,
    messages,
    reactions,
    drafts,
    friendships,
    pollVotes,
    pollChoices,
    attachments,
  ] = await Promise.all([
    sql`
      SELECT id::text AS id, display_name, custom_title, locale, joined_at, last_active_at,
        reputation, post_count, about_md, signature_md, avatar_hash, state,
        hide_online, hide_from_member_list, hide_signatures, hide_friends
      FROM core.members WHERE id = ${memberId}
    ` as Promise<unknown[]>,
    sql`
      SELECT g.key, g.title, mg.is_primary, mg.created_at
      FROM core.member_groups mg
      JOIN core.groups g ON g.id = mg.group_id
      WHERE mg.member_id = ${memberId}
      ORDER BY mg.is_primary DESC, g.key
    ` as Promise<unknown[]>,
    sql`
      SELECT old_name, new_name, changed_at
      FROM core.member_name_history
      WHERE member_id = ${memberId}
      ORDER BY changed_at, id
    ` as Promise<unknown[]>,
    sql`
      SELECT f.type, f.labels, v.value, v.updated_at
      FROM core.member_field_values v
      JOIN core.profile_fields f ON f.id = v.field_id
      WHERE v.member_id = ${memberId}
      ORDER BY f.position, f.id
    ` as Promise<unknown[]>,
    sql`
      SELECT b.key, b.labels, mb.reason, mb.featured, mb.created_at
      FROM core.member_badges mb
      JOIN core.badges b ON b.id = mb.badge_id
      WHERE mb.member_id = ${memberId}
      ORDER BY mb.created_at, mb.id
    ` as Promise<unknown[]>,
    sql`
      SELECT staff_scheme, colour_scheme, theme_id::text AS theme_id, updated_at
      FROM core.member_prefs WHERE member_id = ${memberId}
    ` as Promise<unknown[]>,
    sql`
      SELECT type, channel, enabled
      FROM core.notification_preferences
      WHERE member_id = ${memberId}
      ORDER BY type, channel
    ` as Promise<unknown[]>,
    sql`
      SELECT frequency, last_sent_at, updated_at
      FROM core.digest_subscriptions WHERE member_id = ${memberId}
    ` as Promise<unknown[]>,
    sql`
      SELECT auto_follow_topics, updated_at
      FROM core.follow_settings WHERE member_id = ${memberId}
    ` as Promise<unknown[]>,
    sql`
      SELECT ft.topic_id::text AS topic_id, t.title, t.forum_id::text AS forum_id,
        ft.created_at
      FROM core.followed_topics ft
      LEFT JOIN core.topics t ON t.id = ft.topic_id
      WHERE ft.member_id = ${memberId}
      ORDER BY ft.created_at, ft.topic_id
    ` as Promise<unknown[]>,
    sql`
      SELECT ff.forum_id::text AS forum_id, f.title, f.type, ff.created_at
      FROM core.followed_forums ff
      LEFT JOIN core.forums f ON f.id = ff.forum_id
      WHERE ff.member_id = ${memberId}
      ORDER BY ff.created_at, ff.forum_id
    ` as Promise<unknown[]>,
    sql`
      SELECT fm.followed_id::text AS member_id, m.display_name, fm.created_at
      FROM core.followed_members fm
      LEFT JOIN core.members m ON m.id = fm.followed_id
      WHERE fm.follower_id = ${memberId}
      ORDER BY fm.created_at, fm.followed_id
    ` as Promise<unknown[]>,
    sql`
      SELECT p.id::text AS id, p.topic_id::text AS topic_id,
        t.forum_id::text AS forum_id, t.title AS topic_title,
        t.slug AS topic_slug, p.body_md, p.body_html, p.visibility, p.created_at,
        p.edited_at, p.hold_reason
      FROM core.posts p
      JOIN core.topics t ON t.id = p.topic_id
      WHERE p.author_id = ${memberId}
      ORDER BY p.created_at, p.id
    ` as Promise<unknown[]>,
    sql`
      SELECT r.id::text AS id, r.post_id::text AS post_id, r.body_md, r.body_html,
        r.edited_at, r.created_at
      FROM core.post_revisions r
      JOIN core.posts p ON p.id = r.post_id
      WHERE p.author_id = ${memberId}
      ORDER BY r.edited_at, r.id
    ` as Promise<unknown[]>,
    sql`
      SELECT c.id::text AS id, c.title, c.created_at, cp.state, cp.folder,
        cp.joined_at, cp.left_at
      FROM core.conversations c
      JOIN core.conversation_participants cp ON cp.conversation_id = c.id
      WHERE cp.member_id = ${memberId}
        AND cp.state = 'active'
      ORDER BY c.created_at, c.id
    ` as Promise<unknown[]>,
    sql`
      SELECT m.id::text AS id, m.conversation_id::text AS conversation_id,
        m.author_id::text AS author_id, m.body_md, m.body_html, m.created_at
      FROM core.conversation_messages m
      WHERE m.conversation_id IN (
        SELECT cp.conversation_id
        FROM core.conversation_participants cp
        WHERE cp.member_id = ${memberId}
          AND cp.state = 'active'
      )
      ORDER BY m.conversation_id, m.id
    ` as Promise<unknown[]>,
    sql`
      SELECT pr.post_id::text AS post_id, p.topic_id::text AS topic_id,
        t.forum_id::text AS forum_id, t.title AS topic_title, r.key AS reaction,
        pr.created_at
      FROM core.post_reactions pr
      JOIN core.reactions r ON r.id = pr.reaction_id
      JOIN core.posts p ON p.id = pr.post_id
      JOIN core.topics t ON t.id = p.topic_id
      WHERE pr.member_id = ${memberId}
      ORDER BY pr.created_at, pr.post_id
    ` as Promise<unknown[]>,
    sql`
      SELECT context_key, body_md, updated_at
      FROM core.drafts
      WHERE member_id = ${memberId}
      ORDER BY context_key
    ` as Promise<unknown[]>,
    sql`
      SELECT f.state, f.requested_by::text AS requested_by, f.created_at,
        other.id::text AS member_id, other.display_name
      FROM core.friendships f
      JOIN core.members other
        ON other.id = CASE
          WHEN f.a_member_id = ${memberId} THEN f.b_member_id
          ELSE f.a_member_id
        END
      WHERE f.a_member_id = ${memberId} OR f.b_member_id = ${memberId}
      ORDER BY f.created_at, other.id
    ` as Promise<unknown[]>,
    sql`
      SELECT v.poll_id::text AS poll_id, v.created_at,
        p.topic_id::text AS topic_id, t.title AS topic_title,
        t.slug AS topic_slug, t.forum_id::text AS forum_id
      FROM core.poll_votes v
      JOIN core.polls p ON p.id = v.poll_id
      JOIN core.topics t ON t.id = p.topic_id
      WHERE v.member_id = ${memberId}
      ORDER BY v.created_at, v.poll_id
    ` as Promise<unknown[]>,
    sql`
      SELECT vc.poll_id::text AS poll_id, vc.question_id::text AS question_id,
        q.prompt, vc.choice_id::text AS choice_id, c.label
      FROM core.poll_vote_choices vc
      JOIN core.poll_questions q ON q.id = vc.question_id
      JOIN core.poll_choices c ON c.id = vc.choice_id
      WHERE vc.member_id = ${memberId}
      ORDER BY vc.poll_id, q.position, q.id, c.position, c.id
    ` as Promise<unknown[]>,
    sql`
      SELECT id::text AS id, filename, verified_type, size_bytes, storage_key, created_at
      FROM core.attachments
      WHERE member_id = ${memberId}
        AND state = 'ready'
        AND storage_key IS NOT NULL
        AND deleted_at IS NULL
      ORDER BY id
    ` as Promise<
      Array<{
        id: string;
        filename: string;
        verified_type: string | null;
        size_bytes: string | number;
        storage_key: string;
        created_at: Date;
      }>
    >,
  ]);
  const member = asRecord(members[0]);
  const locale = typeof member?.locale === "string" ? member.locale : "en";
  const warnings = await listMemberWarnings(sql, memberId, locale);
  const tree = await loadForumTree(sql);
  const snapshot = await loadPermissionSnapshot(sql, memberId, { tree, sessionId: null });
  const access = new Map<string, boolean>();
  const readable = async (forumId: string | null, action: "show" | "read"): Promise<boolean> => {
    if (forumId === null) {
      return false;
    }

    const key = `${action}:${forumId}`;
    const cached = access.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const allowed = await can(sql, memberId, action, { forumId, tree, snapshot });
    access.set(key, allowed);
    return allowed;
  };
  const visibleFollowedTopics: unknown[] = [];

  for (const topic of followedTopics as Array<Record<string, unknown>>) {
    const forumId = typeof topic.forum_id === "string" ? topic.forum_id : null;

    if (await readable(forumId, "read")) {
      visibleFollowedTopics.push({
        topic_id: topic.topic_id,
        title: topic.title,
        created_at: topic.created_at,
      });
    }
  }

  const visibleFollowedForums: unknown[] = [];

  for (const forum of followedForums as Array<Record<string, unknown>>) {
    const forumId = typeof forum.forum_id === "string" ? forum.forum_id : null;

    if (await readable(forumId, "show")) {
      visibleFollowedForums.push({
        forum_id: forum.forum_id,
        title: forum.title,
        type: forum.type,
        created_at: forum.created_at,
      });
    }
  }

  const visiblePosts = [];
  for (const post of posts as Array<Record<string, unknown>>) {
    const forumId = typeof post.forum_id === "string" ? post.forum_id : null;
    const allowed = await readable(forumId, "read");
    visiblePosts.push(allowed ? post : { ...post, topic_title: null, topic_slug: null });
  }

  const visibleReactions: unknown[] = [];
  for (const reaction of reactions as Array<Record<string, unknown>>) {
    const forumId = typeof reaction.forum_id === "string" ? reaction.forum_id : null;

    if (await readable(forumId, "read")) {
      visibleReactions.push({
        post_id: reaction.post_id,
        topic_id: reaction.topic_id,
        topic_title: reaction.topic_title,
        reaction: reaction.reaction,
        created_at: reaction.created_at,
      });
    }
  }

  const choicesByPoll = new Map<string, Array<Record<string, unknown>>>();

  for (const choice of pollChoices as Array<Record<string, unknown>>) {
    const pollId = typeof choice.poll_id === "string" ? choice.poll_id : "";
    const choices = choicesByPoll.get(pollId) ?? [];
    choices.push({
      question_id: choice.question_id,
      prompt: choice.prompt,
      choice_id: choice.choice_id,
      label: choice.label,
    });
    choicesByPoll.set(pollId, choices);
  }

  const polls: unknown[] = [];
  for (const vote of pollVotes as Array<Record<string, unknown>>) {
    const forumId = typeof vote.forum_id === "string" ? vote.forum_id : null;
    const allowed = await readable(forumId, "read");
    const pollId = typeof vote.poll_id === "string" ? vote.poll_id : "";
    const choices = choicesByPoll.get(pollId) ?? [];
    polls.push({
      poll_id: vote.poll_id,
      topic_id: vote.topic_id,
      topic_title: allowed ? vote.topic_title : null,
      topic_slug: allowed ? vote.topic_slug : null,
      created_at: vote.created_at,
      choices: allowed
        ? choices
        : choices.map((choice) => ({ ...choice, prompt: null, label: null })),
    });
  }

  const ownRequests = Array.isArray(restricted.dataRequests) ? restricted.dataRequests : [];

  const directory = await mkdtemp(join(tmpdir(), "bulletin-export-"));
  const path = join(directory, "export.zip");
  const writer = Bun.file(path).writer();
  const pendingWrites: Promise<number>[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error !== null) {
      zipError = error;
      return;
    }

    const written = writer.write(chunk);

    if (written instanceof Promise) {
      pendingWrites.push(written);
    }
  });
  const names: string[] = [];
  const add = (name: string, bytes: Uint8Array): void => {
    names.push(name);
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(bytes, true);
  };
  const pluginFailures: string[] = [];

  try {
    add(
      "profile.json",
      jsonBytes({
        member,
        groups,
        nameHistory: history,
        customFields: fields,
        badges,
      }),
    );
    add(
      "settings.json",
      jsonBytes({
        preferences: prefs,
        notifications: notificationPrefs,
        digest,
        follows: followSettings,
      }),
    );
    add(
      "follows.json",
      jsonBytes({
        topics: visibleFollowedTopics,
        forums: visibleFollowedForums,
        members: followedMembers,
      }),
    );
    add("posts.json", jsonBytes({ posts: visiblePosts, revisions }));
    add("conversations.json", jsonBytes({ conversations, messages }));
    add("reactions.json", jsonBytes({ reactions: visibleReactions }));
    add("drafts.json", jsonBytes({ drafts }));
    add("friendships.json", jsonBytes({ friendships }));
    add("polls.json", jsonBytes({ votes: polls }));
    add("requests.json", jsonBytes({ requests: ownRequests }));
    add("warnings.json", jsonBytes({ warnings }));
    add("restricted.json", jsonBytes(restricted));
    const attachmentMetadata: Array<Record<string, unknown>> = [];

    for (const attachment of attachments) {
      const bytes = await storage.get(attachment.storage_key);
      const name = `attachments/${attachment.id}-${safeName(attachment.filename)}`;

      add(name, bytes);
      attachmentMetadata.push({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.verified_type,
        sizeBytes: Number(attachment.size_bytes),
        createdAt: attachment.created_at,
        archivePath: name,
      });
    }

    add("attachments.json", jsonBytes({ attachments: attachmentMetadata }));

    const pluginIds = (await sql`
      SELECT DISTINCT plugin_id FROM core.plugin_personal_data ORDER BY plugin_id
    `) as Array<{ plugin_id: string }>;

    for (const plugin of pluginIds) {
      if (options.pluginExport === undefined) {
        throw new Error(`Plugin ${plugin.plugin_id} has no export handler configured`);
      }

      let result: PluginExportResult;

      try {
        result = await options.pluginExport(plugin.plugin_id, memberId);
      } catch (error) {
        throw new Error(
          `Plugin ${plugin.plugin_id} export failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (!result.ok) {
        throw new Error(
          `Plugin ${plugin.plugin_id} export failed: ${result.error ?? "unknown error"}`,
        );
      }

      add(
        `plugins/${plugin.plugin_id}.json`,
        jsonBytes({
          pluginId: plugin.plugin_id,
          data: result.data ?? {},
        }),
      );
    }

    const generatedAt = (options.now ?? new Date()).toISOString();
    const files = [...names, "manifest.json"].sort();

    add(
      "manifest.json",
      jsonBytes({
        schemaVersion: 1,
        exportedAt: generatedAt,
        memberId,
        files,
        pluginFailures,
      }),
    );

    zip.end();
    await Promise.all(pendingWrites);
    await writer.end();

    if (zipError !== null) {
      throw zipError;
    }

    return {
      path,
      cleanup: () => rm(directory, { recursive: true, force: true }),
      files,
      pluginFailures,
    };
  } catch (error) {
    try {
      await writer.end();
    } catch {
      // The archive is already being discarded.
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Creates the member's export request and queues it through the transactional outbox. */
export async function requestDataExport(
  sql: SQL,
  sessionToken: string,
  memberId: string,
): Promise<string | null> {
  if (!/^\d+$/.test(memberId)) {
    return null;
  }

  return sql.begin(async (tx) => {
    const [row] = (await tx`
      SELECT pii.create_data_request(${sessionToken}, 'export') AS id
    `) as Array<{ id: string | null }>;
    const id = row?.id;

    if (id === null || id === undefined || !/^\d+$/.test(id)) {
      return null;
    }

    await emit(tx, {
      type: "privacy.export.requested",
      aggregateId: BigInt(id),
      aggregateVersion: 1n,
      payloadIds: { requestId: BigInt(id), memberId: BigInt(memberId) },
    });

    return id;
  });
}
