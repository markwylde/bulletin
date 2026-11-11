import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import type { ViewerPrincipal } from "../permissions/principal.ts";
import type { PermissionSnapshot } from "../permissions/snapshot.ts";
import type { ForumTree } from "../permissions/tree.ts";
import type {
  LocalizedText,
  MemberBadge,
  ProfileField,
  ProfileFieldAdmin,
  ProfileFieldGroupRule,
  ProfileFieldOption,
  ProfileFieldType,
  ProfileFieldValue,
  ProfileRecord,
  RecentProfilePost,
} from "./types.ts";

interface ProfileRow {
  readonly id: string;
  readonly display_name: string | null;
  readonly avatar_hash: string | null;
  readonly joined_at: Date;
  readonly last_active_at: Date | null;
  readonly post_count: number;
  readonly reputation: number;
  readonly about_md: string;
  readonly about_html: string;
  readonly hide_online: boolean;
  readonly hide_from_member_list: boolean;
  readonly hide_signatures: boolean;
  readonly hide_friends: boolean;
  readonly custom_title: string | null;
  readonly rank_title_labels: Readonly<Record<string, string>> | null;
  readonly rank_pips: number | null;
  readonly rank_image_key: string | null;
  readonly signature_md: string;
  readonly signature_html: string;
  readonly group_title: string | null;
  readonly group_colour: string | null;
}

function profileRecord(row: ProfileRow): ProfileRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarHash: row.avatar_hash,
    joinedAt: new Date(row.joined_at),
    lastActiveAt: row.last_active_at === null ? null : new Date(row.last_active_at),
    postCount: row.post_count,
    reputation: row.reputation,
    aboutMd: row.about_md,
    aboutHtml: row.about_html,
    hideOnline: row.hide_online,
    hideFromMemberList: row.hide_from_member_list,
    hideSignatures: row.hide_signatures,
    hideFriends: row.hide_friends,
    customTitle: row.custom_title,
    rankTitleLabels: row.rank_title_labels,
    rankPips: row.rank_pips ?? 0,
    rankImageKey: row.rank_image_key,
    signatureMd: row.signature_md,
    signatureHtml: row.signature_html,
    groupTitle: row.group_title,
    groupColour: row.group_colour,
  };
}

export async function readProfile(sql: SQL, memberId: string): Promise<ProfileRecord | null> {
  const [row] = (await sql`
    SELECT
      m.id::text AS id,
      m.display_name,
      m.avatar_hash,
      m.joined_at,
      m.last_active_at,
      m.post_count,
      m.reputation,
      m.about_md,
      m.about_html,
      m.hide_online,
      m.hide_from_member_list,
      m.hide_signatures,
      m.hide_friends,
      m.custom_title,
      m.signature_md,
      m.signature_html,
      rank.title_labels AS rank_title_labels,
      rank.pips AS rank_pips,
      rank.image_key AS rank_image_key,
      g.title AS group_title,
      g.name_colour AS group_colour
    FROM core.members m
    LEFT JOIN core.member_groups mg ON mg.member_id = m.id AND mg.is_primary
    LEFT JOIN core.groups g ON g.id = mg.group_id
    LEFT JOIN LATERAL (
      SELECT title_labels, pips, image_key
      FROM core.ranks
      WHERE min_posts <= m.post_count
      ORDER BY min_posts DESC
      LIMIT 1
    ) rank ON true
    WHERE m.id = ${memberId}
  `) as ProfileRow[];

  return row === undefined ? null : profileRecord(row);
}

interface FieldRow {
  readonly id: string;
  readonly type: ProfileFieldType;
  readonly required: boolean;
  readonly labels: LocalizedText;
  readonly options: readonly ProfileFieldOption[];
  readonly position: number;
}

function fieldRecord(row: FieldRow): ProfileField {
  return {
    id: row.id,
    type: row.type,
    required: row.required,
    labels: row.labels,
    options: row.options,
    position: row.position,
  };
}

export async function listProfileFields(sql: SQL): Promise<readonly ProfileField[]> {
  const rows = (await sql`
    SELECT id::text AS id, type, required, labels, options, position
    FROM core.profile_fields
    ORDER BY position, id
  `) as FieldRow[];

  return rows.map(fieldRecord);
}

export async function readProfileFields(
  sql: SQL,
  fieldIds: ReadonlySet<string>,
): Promise<readonly ProfileField[]> {
  if (fieldIds.size === 0) {
    return [];
  }

  const ids = [...fieldIds].sort();
  const rows = (await sql`
    SELECT id::text AS id, type, required, labels, options, position
    FROM core.profile_fields
    WHERE id = ANY(${`{${ids.join(",")}}`}::bigint[])
    ORDER BY position, id
  `) as FieldRow[];

  return rows.map(fieldRecord);
}

export async function readMemberFieldValues(
  sql: SQL,
  memberId: string,
): Promise<ReadonlyMap<string, ProfileFieldValue>> {
  const rows = (await sql`
    SELECT field_id::text AS field_id, value
    FROM core.member_field_values
    WHERE member_id = ${memberId}
  `) as Array<{ field_id: string; value: ProfileFieldValue }>;

  return new Map(rows.map((row) => [row.field_id, row.value]));
}

export async function listMemberBadges(
  sql: SQL,
  memberId: string,
): Promise<readonly MemberBadge[]> {
  const rows = (await sql`
    SELECT
      b.id::text AS id,
      b.key,
      b.labels,
      b.description_labels,
      b.image_key,
      b.position,
      mb.featured
    FROM core.member_badges mb
    JOIN core.badges b ON b.id = mb.badge_id
    WHERE mb.member_id = ${memberId}
      AND mb.revoked_at IS NULL
    ORDER BY b.position, b.id
  `) as Array<{
    id: string;
    key: string;
    labels: LocalizedText;
    description_labels: Readonly<Partial<Record<string, string>>>;
    image_key: string | null;
    position: number;
    featured: boolean;
  }>;

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    labels: row.labels,
    descriptionLabels: row.description_labels,
    imageKey: row.image_key,
    position: row.position,
    featured: row.featured,
  }));
}

export interface RecentProfilePostsInput {
  readonly memberId: string;
  readonly limit: number;
  readonly principal: ViewerPrincipal;
  readonly sessionId: string | null;
  readonly tree: ForumTree;
  readonly snapshot: PermissionSnapshot;
}

export interface RecentProfilePosts {
  readonly posts: readonly RecentProfilePost[];
  /** Every candidate forum and whether this viewer may read it, for the variant key. */
  readonly forums: readonly { readonly forumId: string; readonly readable: boolean }[];
}

/**
 * The member's latest visible posts, permission-filtered through `can()` (ADR 0005). Every
 * candidate forum's answer is returned so the route can put it in the profile variant key.
 */
export async function readRecentProfilePosts(
  sql: SQL,
  input: RecentProfilePostsInput,
): Promise<RecentProfilePosts> {
  const rows = (await sql`
    SELECT
      p.id::text AS id,
      t.id::text AS topic_id,
      t.title AS topic_title,
      t.slug AS topic_slug,
      t.forum_id::text AS forum_id,
      f.title AS forum_title,
      p.created_at
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    JOIN core.forums f ON f.id = t.forum_id
    WHERE p.author_id = ${input.memberId}
      AND p.visibility = 'visible'
      AND t.moved_to IS NULL
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ${Math.max(input.limit * 4, input.limit)}
  `) as Array<{
    id: string;
    topic_id: string;
    topic_title: string;
    topic_slug: string;
    forum_id: string;
    forum_title: string;
    created_at: Date;
  }>;

  const readableForums = new Map<string, boolean>();

  for (const forumId of new Set(rows.map((row) => row.forum_id))) {
    readableForums.set(
      forumId,
      await can(sql, input.principal, "read", {
        forumId,
        tree: input.tree,
        sessionId: input.sessionId,
        snapshot: input.snapshot,
      }),
    );
  }

  const posts = rows
    .filter((row) => readableForums.get(row.forum_id) === true)
    .slice(0, input.limit)
    .map((row) => ({
      id: row.id,
      topicId: row.topic_id,
      topicTitle: row.topic_title,
      topicSlug: row.topic_slug,
      forumId: row.forum_id,
      forumTitle: row.forum_title,
      createdAt: new Date(row.created_at),
    }));

  return {
    posts,
    forums: [...readableForums.entries()]
      .map(([forumId, readable]) => ({ forumId, readable }))
      .sort((left, right) => left.forumId.localeCompare(right.forumId)),
  };
}

interface FieldGroupRow {
  readonly field_id: string;
  readonly group_id: string;
  readonly group_title: string;
  readonly can_view: boolean;
  readonly can_edit: boolean;
}

function groupRules(rows: readonly FieldGroupRow[]): ReadonlyMap<string, ProfileFieldGroupRule[]> {
  const rules = new Map<string, ProfileFieldGroupRule[]>();

  for (const row of rows) {
    const list = rules.get(row.field_id) ?? [];
    list.push({
      groupId: row.group_id,
      groupTitle: row.group_title,
      canView: row.can_view,
      canEdit: row.can_edit,
    });
    rules.set(row.field_id, list);
  }

  return rules;
}

export async function listProfileFieldsAdmin(sql: SQL): Promise<readonly ProfileFieldAdmin[]> {
  const fields = await listProfileFields(sql);
  const rows = (await sql`
    SELECT
      r.field_id::text AS field_id,
      r.group_id::text AS group_id,
      g.title AS group_title,
      r.can_view,
      r.can_edit
    FROM core.profile_field_groups r
    JOIN core.groups g ON g.id = r.group_id
    ORDER BY g.display_order, g.id
  `) as FieldGroupRow[];
  const rules = groupRules(rows);

  return fields.map((field) => ({ ...field, groups: rules.get(field.id) ?? [] }));
}

export async function listProfileGroups(
  sql: SQL,
): Promise<readonly { readonly id: string; readonly title: string }[]> {
  return (await sql`
    SELECT id::text AS id, title FROM core.groups ORDER BY display_order, id
  `) as Array<{ id: string; title: string }>;
}

export interface ProfileFieldWrite {
  readonly id: string | null;
  readonly type: ProfileFieldType;
  readonly required: boolean;
  readonly labels: LocalizedText;
  readonly options: readonly ProfileFieldOption[];
  readonly position: number;
  readonly groups: readonly {
    readonly groupId: string;
    readonly canView: boolean;
    readonly canEdit: boolean;
  }[];
}

/** Inserts or updates one definition and replaces its group rules. Call from a transaction. */
export async function writeProfileField(tx: SQL, input: ProfileFieldWrite): Promise<string> {
  const labels = input.labels;
  const options = input.options;

  const [field] =
    input.id === null
      ? ((await tx`
          INSERT INTO core.profile_fields (type, required, labels, options, position)
          VALUES (${input.type}, ${input.required}, ${labels}::jsonb, ${options}::jsonb, ${input.position})
          RETURNING id::text AS id
        `) as Array<{ id: string }>)
      : ((await tx`
          UPDATE core.profile_fields
          SET type = ${input.type},
              required = ${input.required},
              labels = ${labels}::jsonb,
              options = ${options}::jsonb,
              position = ${input.position},
              updated_at = now()
          WHERE id = ${input.id}
          RETURNING id::text AS id
        `) as Array<{ id: string }>);

  if (field === undefined) {
    throw new Error("Profile field disappeared while saving");
  }

  await tx`DELETE FROM core.profile_field_groups WHERE field_id = ${field.id}`;

  for (const rule of input.groups) {
    await tx`
      INSERT INTO core.profile_field_groups (field_id, group_id, can_view, can_edit)
      VALUES (${field.id}, ${rule.groupId}, ${rule.canView}, ${rule.canEdit})
    `;
  }

  return field.id;
}

export async function deleteProfileField(sql: SQL, fieldId: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM core.profile_fields WHERE id = ${fieldId} RETURNING id
  `) as unknown[];

  return rows.length > 0;
}

/** The profile row and all stored values, for the member's own edit form. */
export interface EditableProfile {
  readonly profile: ProfileRecord;
  readonly values: ReadonlyMap<string, ProfileFieldValue>;
}

export async function readEditableProfile(
  sql: SQL,
  memberId: string,
): Promise<EditableProfile | null> {
  const profile = await readProfile(sql, memberId);

  if (profile === null) {
    return null;
  }

  return { profile, values: await readMemberFieldValues(sql, memberId) };
}

export interface ProfileRowUpdate {
  readonly aboutMd: string;
  readonly aboutHtml: string;
  readonly hideOnline: boolean;
  readonly hideFromMemberList: boolean;
}

export async function updateProfileRow(
  tx: SQL,
  memberId: string,
  input: ProfileRowUpdate,
): Promise<void> {
  await tx`
    UPDATE core.members
    SET about_md = ${input.aboutMd},
        about_html = ${input.aboutHtml},
        hide_online = ${input.hideOnline},
        hide_from_member_list = ${input.hideFromMemberList}
    WHERE id = ${memberId}
  `;
}

export async function replaceFieldValues(
  tx: SQL,
  memberId: string,
  values: ReadonlyMap<string, ProfileFieldValue>,
  editableFieldIds: readonly string[],
): Promise<void> {
  if (editableFieldIds.length === 0) {
    return;
  }

  const ids = [...values.keys()];
  const editable = `{${editableFieldIds.join(",")}}`;

  if (ids.length === 0) {
    await tx`
      DELETE FROM core.member_field_values
      WHERE member_id = ${memberId}
        AND field_id = ANY(${editable}::bigint[])
    `;
    return;
  }

  await tx`
    DELETE FROM core.member_field_values
    WHERE member_id = ${memberId}
      AND field_id = ANY(${editable}::bigint[])
      AND NOT (field_id = ANY(${`{${ids.join(",")}}`}::bigint[]))
  `;

  for (const [fieldId, value] of values) {
    await tx`
      INSERT INTO core.member_field_values (member_id, field_id, value, updated_at)
      VALUES (${memberId}, ${fieldId}, ${value}::jsonb, now())
      ON CONFLICT (member_id, field_id) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now()
    `;
  }
}

/** The rendered signature for each of the given members; empty signatures are omitted. */
export async function readMemberSignatures(
  sql: SQL,
  memberIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(memberIds)].sort();

  if (ids.length === 0) {
    return new Map();
  }

  const rows = (await sql`
    SELECT id::text AS id, signature_html
    FROM core.members
    WHERE id = ANY(${`{${ids.join(",")}}`}::bigint[])
      AND signature_html <> ''
  `) as Array<{ id: string; signature_html: string }>;

  return new Map(rows.map((row) => [row.id, row.signature_html]));
}

/** Stores a rendered signature. Called in the same transaction as the `member:{id}` bump. */
export async function updateMemberSignature(
  tx: SQL,
  memberId: string,
  input: { readonly bodyHtml: string; readonly bodyMd: string },
): Promise<void> {
  await tx`
    UPDATE core.members
    SET signature_md = ${input.bodyMd},
        signature_html = ${input.bodyHtml},
        signature_updated_at = now()
    WHERE id = ${memberId}
  `;
}

/** Stores the member's "hide all signatures" preference (applied by the overlay, ADR 0006). */
export async function updateHideSignatures(
  tx: SQL,
  memberId: string,
  hide: boolean,
): Promise<void> {
  await tx`UPDATE core.members SET hide_signatures = ${hide} WHERE id = ${memberId}`;
}

/** Stores the member's "hide my friend list" privacy preference. */
export async function updateHideFriends(tx: SQL, memberId: string, hide: boolean): Promise<void> {
  await tx`UPDATE core.members SET hide_friends = ${hide} WHERE id = ${memberId}`;
}

/** Stores the member's custom title, or clears it with null. */
export async function updateCustomTitle(
  tx: SQL,
  memberId: string,
  title: string | null,
): Promise<void> {
  await tx`UPDATE core.members SET custom_title = ${title} WHERE id = ${memberId}`;
}

/** Marks exactly the selected awarded badges as featured (the caller validates the count). */
export async function replaceFeaturedBadges(
  tx: SQL,
  memberId: string,
  badgeIds: readonly string[],
): Promise<void> {
  await tx`UPDATE core.member_badges SET featured = false WHERE member_id = ${memberId}`;

  if (badgeIds.length > 0) {
    await tx`
      UPDATE core.member_badges
      SET featured = true
      WHERE member_id = ${memberId}
        AND revoked_at IS NULL
        AND badge_id = ANY(${`{${badgeIds.join(",")}}`}::bigint[])
    `;
  }
}
