import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import { strToU8, zipSync } from "fflate";
import { emit } from "../events/outbox.ts";
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
  readonly bytes: Uint8Array;
  readonly files: readonly string[];
  readonly pluginFailures: readonly string[];
}

function file(value: unknown): Uint8Array {
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
      SELECT ft.topic_id::text AS topic_id, t.title, ft.created_at
      FROM core.followed_topics ft
      LEFT JOIN core.topics t ON t.id = ft.topic_id
      WHERE ft.member_id = ${memberId}
      ORDER BY ft.created_at, ft.topic_id
    ` as Promise<unknown[]>,
    sql`
      SELECT ff.forum_id::text AS forum_id, f.title, ff.created_at
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
      SELECT p.id::text AS id, p.topic_id::text AS topic_id, t.title AS topic_title,
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
      )
      ORDER BY m.conversation_id, m.id
    ` as Promise<unknown[]>,
    sql`
      SELECT pr.post_id::text AS post_id, p.topic_id::text AS topic_id,
        t.title AS topic_title, r.key AS reaction, pr.created_at
      FROM core.post_reactions pr
      JOIN core.reactions r ON r.id = pr.reaction_id
      JOIN core.posts p ON p.id = pr.post_id
      JOIN core.topics t ON t.id = p.topic_id
      WHERE pr.member_id = ${memberId}
      ORDER BY pr.created_at, pr.post_id
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
  const files: Record<string, Uint8Array> = {
    "profile.json": file({
      member,
      groups,
      nameHistory: history,
      customFields: fields,
      badges,
    }),
    "settings.json": file({
      preferences: prefs,
      notifications: notificationPrefs,
      digest,
      follows: followSettings,
    }),
    "follows.json": file({
      topics: followedTopics,
      forums: followedForums,
      members: followedMembers,
    }),
    "posts.json": file({ posts, revisions }),
    "conversations.json": file({ conversations, messages }),
    "reactions.json": file({ reactions }),
    "warnings.json": file({ warnings }),
    "restricted.json": file(restricted),
  };
  const attachmentMetadata: Array<Record<string, unknown>> = [];

  for (const attachment of attachments) {
    const bytes = await storage.get(attachment.storage_key);
    const name = `attachments/${attachment.id}-${safeName(attachment.filename)}`;

    files[name] = bytes;
    attachmentMetadata.push({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.verified_type,
      sizeBytes: Number(attachment.size_bytes),
      createdAt: attachment.created_at,
      archivePath: name,
    });
  }

  files["attachments.json"] = file({ attachments: attachmentMetadata });

  const pluginIds = (await sql`
    SELECT DISTINCT plugin_id FROM core.plugin_personal_data ORDER BY plugin_id
  `) as Array<{ plugin_id: string }>;
  const pluginFailures: string[] = [];

  for (const plugin of pluginIds) {
    if (options.pluginExport === undefined) {
      pluginFailures.push(plugin.plugin_id);
      files[`plugins/${plugin.plugin_id}.json`] = file({
        pluginId: plugin.plugin_id,
        error: "no plugin exporter configured",
      });
      continue;
    }

    try {
      const result = await options.pluginExport(plugin.plugin_id, memberId);

      if (!result.ok) {
        pluginFailures.push(plugin.plugin_id);
        files[`plugins/${plugin.plugin_id}.json`] = file({
          pluginId: plugin.plugin_id,
          error: result.error ?? "export failed",
        });
        continue;
      }

      files[`plugins/${plugin.plugin_id}.json`] = file({
        pluginId: plugin.plugin_id,
        data: result.data ?? {},
      });
    } catch (error) {
      pluginFailures.push(plugin.plugin_id);
      files[`plugins/${plugin.plugin_id}.json`] = file({
        pluginId: plugin.plugin_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const generatedAt = (options.now ?? new Date()).toISOString();

  files["manifest.json"] = file({
    schemaVersion: 1,
    exportedAt: generatedAt,
    memberId,
    files: Object.keys(files).sort(),
    pluginFailures,
  });

  return {
    bytes: zipSync(files),
    files: Object.keys(files).sort(),
    pluginFailures,
  };
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
