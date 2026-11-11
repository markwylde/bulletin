import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import { memberBanned } from "../permissions/moderator.ts";
import { type GroupSettingValue, mergeGroupSettings } from "../permissions/registry.ts";
import { loadMemberGroups } from "../permissions/store.ts";
import { isIgnoring } from "../relationships/repository.ts";

/** `0` means unlimited for the PM quota and the daily start limit (group settings). */
export interface PmPolicy {
  readonly canUse: boolean;
  /** Recipients other than the starter. */
  readonly recipientLimit: number;
  readonly dailyLimit: number;
  /** Conversations the member may keep active; 0 is unlimited. */
  readonly quota: number;
}

export interface StartUsage {
  /** The member's currently active participations; the quota counts these. */
  readonly active: number;
  readonly startedToday: number;
  /** When the daily counter resets (start of the next day on the database clock). */
  readonly resetsAt: Date;
}

export interface ConversationParticipant {
  readonly id: string;
  readonly displayName: string | null;
  readonly avatarHash: string | null;
}

export interface ConversationMessage {
  readonly id: string;
  readonly authorId: string;
  readonly authorName: string | null;
  readonly bodyHtml: string;
  readonly createdAt: Date;
}

/** A conversation as one current participant sees it, including the full history. */
export interface ConversationDetail {
  readonly id: string;
  readonly title: string;
  readonly starterId: string;
  readonly createdAt: Date;
  readonly lastMessageAt: Date;
  readonly participants: readonly ConversationParticipant[];
  readonly messages: readonly ConversationMessage[];
}

export interface NewConversation {
  readonly id: string;
  readonly createdAt: Date;
}

export interface NewConversationMessage {
  readonly id: string;
  readonly createdAt: Date;
}

const MEMBER_ID = /^[1-9]\d{0,18}$/;
const CONVERSATION_ID = /^[1-9]\d{0,18}$/;

function numberSetting(
  settings: Readonly<Record<string, GroupSettingValue>>,
  key: string,
  fallback: number,
): number {
  const value = settings[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * The member's PM limits and whether they may use PMs at all. `can("use_pm")` is the
 * `cannot_pm` restriction; the Banned group is the same sender restriction by another route.
 */
export async function readPmPolicy(sql: SQL, memberId: string): Promise<PmPolicy> {
  const groups = await loadMemberGroups(sql, memberId);
  const settings = mergeGroupSettings(groups);
  const allowed = await can(sql, memberId, "use_pm");

  return {
    canUse: allowed && !memberBanned(groups, settings),
    recipientLimit: numberSetting(settings, "posting.pm_recipients", 1),
    dailyLimit: numberSetting(settings, "posting.pm_daily_starts", 20),
    quota: numberSetting(settings, "posting.pm_quota", 0),
  };
}

/** Whether a member can send or receive private messages right now. */
export async function memberCanUsePms(sql: SQL, memberId: string): Promise<boolean> {
  return (await readPmPolicy(sql, memberId)).canUse;
}

/** A missing, service or erasing member is never a valid recipient; the caller stays generic. */
export async function memberIsReachable(sql: SQL, memberId: string): Promise<boolean> {
  if (!MEMBER_ID.test(memberId)) {
    return false;
  }

  const rows = (await sql`
    SELECT 1
    FROM core.members
    WHERE id = ${memberId}
      AND state = 'active'
      AND is_service = false
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}

/** True when the recipient has the starter on their private ignore list. */
export function recipientIgnores(
  sql: SQL,
  recipientId: string,
  starterId: string,
): Promise<boolean> {
  return isIgnoring(sql, recipientId, starterId);
}

/** Serialises starts for one member so the quota and daily limit cannot be raced. */
export async function lockMemberForStart(sql: SQL, memberId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT id FROM core.members WHERE id = ${memberId} FOR UPDATE
  `) as unknown[];

  return rows.length > 0;
}

export async function readStartUsage(sql: SQL, memberId: string): Promise<StartUsage> {
  const [row] = (await sql`
    SELECT
      (
        SELECT count(*)::int
        FROM core.conversation_participants
        WHERE member_id = ${memberId} AND state = 'active'
      ) AS active,
      (
        SELECT count(*)::int
        FROM core.conversations
        WHERE starter_id = ${memberId}
          AND created_at >= date_trunc('day', now())
      ) AS started_today,
      date_trunc('day', now()) + interval '1 day' AS resets_at
  `) as Array<{ active: number; started_today: number; resets_at: Date }>;

  return {
    active: row?.active ?? 0,
    startedToday: row?.started_today ?? 0,
    resetsAt: row?.resets_at ?? new Date(),
  };
}

export async function insertConversation(
  sql: SQL,
  input: { readonly title: string; readonly starterId: string },
): Promise<NewConversation> {
  const [row] = (await sql`
    INSERT INTO core.conversations (title, starter_id)
    VALUES (${input.title}, ${input.starterId})
    RETURNING id::text AS id, created_at
  `) as Array<{ id: string; created_at: Date }>;

  if (row === undefined) {
    throw new Error("Could not insert the conversation");
  }

  return { id: row.id, createdAt: new Date(row.created_at) };
}

export async function insertParticipant(
  sql: SQL,
  input: { readonly conversationId: string; readonly memberId: string },
): Promise<void> {
  await sql`
    INSERT INTO core.conversation_participants (conversation_id, member_id)
    VALUES (${input.conversationId}, ${input.memberId})
  `;
}

export async function insertConversationMessage(
  sql: SQL,
  input: {
    readonly conversationId: string;
    readonly authorId: string;
    readonly bodyMd: string;
    readonly bodyHtml: string;
    readonly bodyText: string;
  },
): Promise<NewConversationMessage> {
  const [row] = (await sql`
    INSERT INTO core.conversation_messages (
      conversation_id, author_id, body_md, body_html, body_text
    )
    VALUES (
      ${input.conversationId},
      ${input.authorId},
      ${input.bodyMd},
      ${input.bodyHtml},
      ${input.bodyText}
    )
    RETURNING id::text AS id, created_at
  `) as Array<{ id: string; created_at: Date }>;

  if (row === undefined) {
    throw new Error("Could not insert the conversation message");
  }

  return { id: row.id, createdAt: new Date(row.created_at) };
}

export async function touchConversation(sql: SQL, conversationId: string, at: Date): Promise<void> {
  await sql`
    UPDATE core.conversations
    SET last_message_at = ${at}
    WHERE id = ${conversationId}
  `;
}

/**
 * The participant-only read (design): every query joins the viewer's active participation, so
 * unknown and unauthorised IDs both look absent. There is no staff or admin bypass here.
 */
export async function readConversationForParticipant(
  sql: SQL,
  conversationId: string,
  memberId: string,
): Promise<ConversationDetail | null> {
  if (!CONVERSATION_ID.test(conversationId) || !MEMBER_ID.test(memberId)) {
    return null;
  }

  const [conversation] = (await sql`
    SELECT
      c.id::text AS id,
      c.title,
      c.starter_id::text AS starter_id,
      c.created_at,
      c.last_message_at
    FROM core.conversations c
    JOIN core.conversation_participants viewer
      ON viewer.conversation_id = c.id
     AND viewer.member_id = ${memberId}
     AND viewer.state = 'active'
    WHERE c.id = ${conversationId}
  `) as Array<{
    id: string;
    title: string;
    starter_id: string;
    created_at: Date;
    last_message_at: Date;
  }>;

  if (conversation === undefined) {
    return null;
  }

  const participants = (await sql`
    SELECT
      m.id::text AS id,
      m.display_name,
      m.avatar_hash
    FROM core.conversation_participants p
    JOIN core.conversation_participants viewer
      ON viewer.conversation_id = p.conversation_id
     AND viewer.member_id = ${memberId}
     AND viewer.state = 'active'
    JOIN core.members m ON m.id = p.member_id
    WHERE p.conversation_id = ${conversationId}
      AND p.state = 'active'
    ORDER BY p.joined_at, m.id
  `) as Array<{ id: string; display_name: string | null; avatar_hash: string | null }>;

  const messages = (await sql`
    SELECT
      msg.id::text AS id,
      msg.author_id::text AS author_id,
      m.display_name AS author_name,
      msg.body_html,
      msg.created_at
    FROM core.conversation_messages msg
    JOIN core.conversation_participants viewer
      ON viewer.conversation_id = msg.conversation_id
     AND viewer.member_id = ${memberId}
     AND viewer.state = 'active'
    LEFT JOIN core.members m ON m.id = msg.author_id
    WHERE msg.conversation_id = ${conversationId}
    ORDER BY msg.id
  `) as Array<{
    id: string;
    author_id: string;
    author_name: string | null;
    body_html: string;
    created_at: Date;
  }>;

  return {
    id: conversation.id,
    title: conversation.title,
    starterId: conversation.starter_id,
    createdAt: new Date(conversation.created_at),
    lastMessageAt: new Date(conversation.last_message_at),
    participants: participants.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      avatarHash: row.avatar_hash,
    })),
    messages: messages.map((row) => ({
      id: row.id,
      authorId: row.author_id,
      authorName: row.author_name,
      bodyHtml: row.body_html,
      createdAt: new Date(row.created_at),
    })),
  };
}
