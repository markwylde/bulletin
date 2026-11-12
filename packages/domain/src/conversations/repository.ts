import {
  currentContentVersions,
  ensureCurrentRendering,
  type QuotePipeline,
} from "@bulletin/content";
import type { SQL } from "bun";
import { listEmbedProviders } from "../content/embeds.ts";
import { insertQuoteSnapshot } from "../content/quotes.ts";
import { can } from "../permissions/can.ts";
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
  readonly bodyText: string;
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
  readonly createdAt: Date;
}

/** The viewer's own row in a conversation: folder, read marker and starter flag. */
export interface ConversationViewer {
  readonly isStarter: boolean;
  readonly folder: "inbox" | "archive";
  readonly lastReadMessageId: string | null;
  readonly unreadCount: number;
}

/** A conversation as one current participant sees it, including the full history. */
export interface ConversationDetail {
  readonly id: string;
  readonly title: string;
  readonly starterId: string;
  readonly createdAt: Date;
  readonly lastMessageAt: Date;
  readonly viewer: ConversationViewer;
  readonly participants: readonly ConversationParticipant[];
  readonly messages: readonly ConversationMessage[];
}

/** One active participation, used by every participant action. */
export interface ConversationParticipation {
  readonly conversationId: string;
  readonly memberId: string;
  readonly isStarter: boolean;
  readonly folder: "inbox" | "archive";
  readonly lastReadMessageId: string | null;
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

export type SearchConfig = "english" | "spanish" | "french" | "simple";

/** ADR 0017: content is indexed with a real language config, with `simple` as the fallback. */
export function textSearchConfig(locale: string | null | undefined): SearchConfig {
  switch (locale) {
    case "es":
      return "spanish";
    case "fr":
      return "french";
    case "en":
      return "english";
    default:
      return "simple";
  }
}

export async function readMemberSearchConfig(sql: SQL, memberId: string): Promise<SearchConfig> {
  const [row] = (await sql`
    SELECT locale FROM core.members WHERE id = ${memberId}
  `) as Array<{ locale: string | null }>;

  return textSearchConfig(row?.locale);
}

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
  const [pmAllowed, sendAllowed] = await Promise.all([
    can(sql, memberId, "use_pm"),
    can(sql, memberId, "send_pm"),
  ]);

  return {
    canUse: pmAllowed && sendAllowed,
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
      COALESCE(
        (
          SELECT starts FROM core.conversation_daily_starts
          WHERE member_id = ${memberId} AND day = current_date
        ),
        0
      ) AS started_today,
      date_trunc('day', now()) + interval '1 day' AS resets_at
  `) as Array<{ active: number; started_today: number; resets_at: Date }>;

  return {
    active: row?.active ?? 0,
    startedToday: row?.started_today ?? 0,
    resetsAt: row?.resets_at ?? new Date(),
  };
}

/** Counts one successful start for the member's current day (review finding P2). */
export async function recordConversationStart(sql: SQL, memberId: string): Promise<void> {
  await sql`
    INSERT INTO core.conversation_daily_starts (member_id, day, starts, updated_at)
    VALUES (${memberId}, current_date, 1, now())
    ON CONFLICT (member_id, day) DO UPDATE
      SET starts = core.conversation_daily_starts.starts + 1, updated_at = now()
  `;
}

/** True when the message belongs to the conversation and the viewer still participates. */
export async function isConversationMessageReadable(
  sql: SQL,
  conversationId: string,
  messageId: string,
  memberId: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM core.conversation_messages msg
    JOIN core.conversation_participants p
      ON p.conversation_id = msg.conversation_id
     AND p.member_id = ${memberId}
     AND p.state = 'active'
    WHERE msg.id = ${messageId} AND msg.conversation_id = ${conversationId}
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}

export async function insertConversation(
  sql: SQL,
  input: { readonly title: string; readonly starterId: string; readonly lang: SearchConfig },
): Promise<NewConversation> {
  const [row] = (await sql`
    INSERT INTO core.conversations (title, starter_id, lang)
    VALUES (${input.title}, ${input.starterId}, ${input.lang}::regconfig)
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
    readonly lang: SearchConfig;
    readonly renderVersion: number;
    readonly sanitiserVersion: number;
  },
): Promise<NewConversationMessage> {
  const [row] = (await sql`
    INSERT INTO core.conversation_messages (
      conversation_id, author_id, body_md, body_html, body_text, lang,
      render_version, sanitiser_version
    )
    VALUES (
      ${input.conversationId},
      ${input.authorId},
      ${input.bodyMd},
      ${input.bodyHtml},
      ${input.bodyText},
      ${input.lang}::regconfig,
      ${input.renderVersion},
      ${input.sanitiserVersion}
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
      c.last_message_at,
      viewer.folder,
      viewer.last_read_message_id::text AS last_read_message_id
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
    folder: "inbox" | "archive";
    last_read_message_id: string | null;
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
      msg.body_text,
      msg.render_version,
      msg.sanitiser_version,
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
    body_text: string;
    render_version: number;
    sanitiser_version: number;
    created_at: Date;
  }>;

  const lastRead = conversation.last_read_message_id;
  const unreadCount =
    lastRead === null
      ? messages.length
      : messages.filter((row) => BigInt(row.id) > BigInt(lastRead)).length;

  return {
    id: conversation.id,
    title: conversation.title,
    starterId: conversation.starter_id,
    createdAt: new Date(conversation.created_at),
    lastMessageAt: new Date(conversation.last_message_at),
    viewer: {
      isStarter: conversation.starter_id === memberId,
      folder: conversation.folder,
      lastReadMessageId: lastRead,
      unreadCount,
    },
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
      bodyText: row.body_text,
      renderVersion: row.render_version,
      sanitiserVersion: row.sanitiser_version,
      createdAt: new Date(row.created_at),
    })),
  };
}

/** Re-sanitises stored message HTML for a JSON read before it leaves the API (ADR 0007). */
export async function refreshConversationMessagesForRead(
  sql: SQL,
  messages: readonly ConversationMessage[],
): Promise<readonly ConversationMessage[]> {
  if (messages.length === 0) {
    return [];
  }

  const embedProviders = await listEmbedProviders(sql);
  const versions = currentContentVersions();

  return Promise.all(
    messages.map(async (message) => {
      const current = await ensureCurrentRendering(
        {
          bodyHtml: message.bodyHtml,
          bodyText: message.bodyText,
          renderVersion: message.renderVersion,
          sanitiserVersion: message.sanitiserVersion,
        },
        { profile: "post", embedProviders },
      );

      return {
        ...message,
        bodyHtml: current.bodyHtml,
        bodyText: current.bodyText,
        renderVersion: versions.renderVersion,
        sanitiserVersion: versions.sanitiserVersion,
      };
    }),
  );
}

/** Locks the conversation row so a reply, invite and removal cannot interleave. */
export async function lockConversationForWrite(sql: SQL, conversationId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT id FROM core.conversations WHERE id = ${conversationId} FOR UPDATE
  `) as unknown[];

  return rows.length > 0;
}

export async function readParticipation(
  sql: SQL,
  conversationId: string,
  memberId: string,
): Promise<ConversationParticipation | null> {
  const [row] = (await sql`
    SELECT
      c.id::text AS conversation_id,
      c.starter_id::text AS starter_id,
      p.member_id::text AS member_id,
      p.folder,
      p.last_read_message_id::text AS last_read_message_id
    FROM core.conversations c
    JOIN core.conversation_participants p
      ON p.conversation_id = c.id
     AND p.member_id = ${memberId}
     AND p.state = 'active'
    WHERE c.id = ${conversationId}
  `) as Array<{
    conversation_id: string;
    starter_id: string;
    member_id: string;
    folder: "inbox" | "archive";
    last_read_message_id: string | null;
  }>;

  return row === undefined
    ? null
    : {
        conversationId: row.conversation_id,
        memberId: row.member_id,
        isStarter: row.starter_id === row.member_id,
        folder: row.folder,
        lastReadMessageId: row.last_read_message_id,
      };
}

/** The row's current state, including a former participant's block flag. */
export async function readParticipantState(
  sql: SQL,
  conversationId: string,
  memberId: string,
): Promise<{
  readonly state: "active" | "left" | "removed";
  readonly blockReinvite: boolean;
} | null> {
  const [row] = (await sql`
    SELECT state, block_reinvite
    FROM core.conversation_participants
    WHERE conversation_id = ${conversationId} AND member_id = ${memberId}
  `) as Array<{ state: "active" | "left" | "removed"; block_reinvite: boolean }>;

  return row === undefined ? null : { state: row.state, blockReinvite: row.block_reinvite };
}

export async function countActiveParticipants(sql: SQL, conversationId: string): Promise<number> {
  const [row] = (await sql`
    SELECT count(*)::int AS count
    FROM core.conversation_participants
    WHERE conversation_id = ${conversationId} AND state = 'active'
  `) as Array<{ count: number }>;

  return row?.count ?? 0;
}

export async function countConversationMessages(sql: SQL, conversationId: string): Promise<bigint> {
  const [row] = (await sql`
    SELECT count(*)::bigint AS count
    FROM core.conversation_messages
    WHERE conversation_id = ${conversationId}
  `) as Array<{ count: bigint | string }>;

  return row === undefined ? 0n : BigInt(row.count);
}

/**
 * Records a new message: the conversation moves to the top, archived participants return to
 * the inbox (spec: archive + auto-unarchive on reply) and the author has read their own copy.
 */
export async function recordConversationReply(
  sql: SQL,
  input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly authorId: string;
    readonly at: Date;
  },
): Promise<void> {
  await touchConversation(sql, input.conversationId, input.at);
  await sql`
    UPDATE core.conversation_participants
    SET folder = 'inbox'
    WHERE conversation_id = ${input.conversationId}
      AND state = 'active'
      AND folder = 'archive'
  `;
  await sql`
    UPDATE core.conversation_participants
    SET last_read_message_id = ${input.messageId}, folder = 'inbox'
    WHERE conversation_id = ${input.conversationId}
      AND member_id = ${input.authorId}
      AND state = 'active'
  `;
  // Wake open conversation streams; the durable rows are read on wake-up (ADR 0011).
  await sql`SELECT pg_notify('conversation_activity', ${input.conversationId})`;
}

export async function maxConversationMessageId(sql: SQL, conversationId: string): Promise<bigint> {
  const [row] = (await sql`
    SELECT coalesce(max(id), 0)::text AS id
    FROM core.conversation_messages
    WHERE conversation_id = ${conversationId}
  `) as Array<{ id: string }>;

  return BigInt(row?.id ?? "0");
}

/** Message ids after the client's cursor, restricted to an active participant. */
export async function visibleConversationMessageIdsAfter(
  sql: SQL,
  conversationId: string,
  memberId: string,
  afterId: bigint,
  limit: number,
): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT msg.id::text AS id
    FROM core.conversation_messages msg
    JOIN core.conversation_participants p
      ON p.conversation_id = msg.conversation_id
     AND p.member_id = ${memberId}
     AND p.state = 'active'
    WHERE msg.conversation_id = ${conversationId}
      AND msg.id > ${afterId}
    ORDER BY msg.id
    LIMIT ${limit}
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/** Full new-message payload for the open conversation after the client's cursor. */
export async function readConversationMessagesAfter(
  sql: SQL,
  conversationId: string,
  memberId: string,
  afterId: string,
  limit = 100,
): Promise<readonly ConversationMessage[]> {
  if (
    !CONVERSATION_ID.test(conversationId) ||
    !MEMBER_ID.test(memberId) ||
    !/^\d+$/.test(afterId)
  ) {
    return [];
  }

  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = (await sql`
    SELECT
      msg.id::text AS id,
      msg.author_id::text AS author_id,
      m.display_name AS author_name,
      msg.body_html,
      msg.body_text,
      msg.render_version,
      msg.sanitiser_version,
      msg.created_at
    FROM core.conversation_messages msg
    JOIN core.conversation_participants p
      ON p.conversation_id = msg.conversation_id
     AND p.member_id = ${memberId}
     AND p.state = 'active'
    LEFT JOIN core.members m ON m.id = msg.author_id
    WHERE msg.conversation_id = ${conversationId}
      AND msg.id > ${afterId}
    ORDER BY msg.id
    LIMIT ${bounded}
  `) as Array<{
    id: string;
    author_id: string;
    author_name: string | null;
    body_html: string;
    body_text: string;
    render_version: number;
    sanitiser_version: number;
    created_at: Date;
  }>;

  return rows.map((row) => ({
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    renderVersion: row.render_version,
    sanitiserVersion: row.sanitiser_version,
    createdAt: new Date(row.created_at),
  }));
}

/** Marks every current message read; the page renders the whole history. */
export async function markConversationRead(
  sql: SQL,
  conversationId: string,
  memberId: string,
  messageId: string | null = null,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE core.conversation_participants p
    SET last_read_message_id = GREATEST(
      p.last_read_message_id,
      (
        SELECT max(id)
        FROM core.conversation_messages
        WHERE conversation_id = ${conversationId}
          AND (${messageId}::bigint IS NULL OR id <= ${messageId}::bigint)
      )
    )
    WHERE p.conversation_id = ${conversationId}
      AND p.member_id = ${memberId}
      AND p.state = 'active'
    RETURNING 1
  `) as unknown[];

  return rows.length > 0;
}

export async function setParticipantFolder(
  sql: SQL,
  conversationId: string,
  memberId: string,
  folder: "inbox" | "archive",
): Promise<boolean> {
  const rows = (await sql`
    UPDATE core.conversation_participants
    SET folder = ${folder}
    WHERE conversation_id = ${conversationId}
      AND member_id = ${memberId}
      AND state = 'active'
    RETURNING 1
  `) as unknown[];

  return rows.length > 0;
}

/** Re-activates a former participant (or inserts one) with the full history unread. */
export async function inviteParticipant(
  sql: SQL,
  conversationId: string,
  memberId: string,
): Promise<void> {
  await sql`
    INSERT INTO core.conversation_participants (conversation_id, member_id)
    VALUES (${conversationId}, ${memberId})
    ON CONFLICT (conversation_id, member_id) DO UPDATE
      SET state = 'active',
          joined_at = now(),
          left_at = NULL,
          last_read_message_id = NULL,
          folder = 'inbox',
          block_reinvite = false
  `;
}

export async function markParticipantRemoved(
  sql: SQL,
  conversationId: string,
  memberId: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE core.conversation_participants
    SET state = 'removed', left_at = now()
    WHERE conversation_id = ${conversationId}
      AND member_id = ${memberId}
      AND state = 'active'
    RETURNING 1
  `) as unknown[];

  return rows.length > 0;
}

export async function markParticipantLeft(
  sql: SQL,
  conversationId: string,
  memberId: string,
  blockReinvite: boolean,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE core.conversation_participants
    SET state = 'left', left_at = now(), block_reinvite = ${blockReinvite}
    WHERE conversation_id = ${conversationId}
      AND member_id = ${memberId}
      AND state = 'active'
    RETURNING 1
  `) as unknown[];

  return rows.length > 0;
}

/** Messages can quote only messages from the same conversation the author still participates in. */
export function createConversationQuotePipeline(sql: SQL, conversationId: string): QuotePipeline {
  return {
    resolver: {
      async canRead(ref, authorId): Promise<boolean> {
        if (ref.kind !== "message") {
          return false;
        }

        const rows = (await sql`
          SELECT 1
          FROM core.conversation_messages msg
          JOIN core.conversation_participants p
            ON p.conversation_id = msg.conversation_id
           AND p.member_id = ${authorId}
           AND p.state = 'active'
          WHERE msg.id = ${ref.id}
            AND msg.conversation_id = ${conversationId}
          LIMIT 1
        `) as unknown[];

        return rows.length > 0;
      },
      async load(ref) {
        if (ref.kind !== "message") {
          return null;
        }

        const [row] = (await sql`
          SELECT
            msg.id::text AS id,
            msg.author_id::text AS author_id,
            msg.body_md,
            msg.conversation_id::text AS conversation_id
          FROM core.conversation_messages msg
          WHERE msg.id = ${ref.id}
            AND msg.conversation_id = ${conversationId}
        `) as Array<{
          id: string;
          author_id: string;
          body_md: string;
          conversation_id: string;
        }>;

        return row === undefined
          ? null
          : {
              ref: { kind: "message", id: row.id },
              sourceAuthorId: row.author_id,
              bodyMd: row.body_md,
              contextId: row.conversation_id,
            };
      },
    },
    snapshots: {
      create: (draft) => insertQuoteSnapshot(sql, draft),
    },
  };
}

export type ConversationFolder = "inbox" | "sent" | "archive";

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly starterId: string;
  readonly folder: ConversationFolder;
  readonly lastMessageAt: Date;
  readonly unreadCount: number;
  readonly participants: readonly ConversationParticipant[];
}

export interface ConversationLists {
  readonly inbox: readonly ConversationSummary[];
  readonly sent: readonly ConversationSummary[];
  readonly archive: readonly ConversationSummary[];
}

interface SummaryRow {
  readonly id: string;
  readonly title: string;
  readonly starter_id: string;
  readonly folder: "inbox" | "archive";
  readonly last_message_at: Date;
  readonly unread_count: number;
  readonly participant_rows: readonly {
    readonly id: string;
    readonly displayName: string | null;
    readonly avatarHash: string | null;
  }[];
}

function summaryFolder(row: SummaryRow, memberId: string): ConversationFolder {
  if (row.folder === "archive") {
    return "archive";
  }

  return row.starter_id === memberId ? "sent" : "inbox";
}

function summaryFromRow(row: SummaryRow, memberId: string): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    starterId: row.starter_id,
    folder: summaryFolder(row, memberId),
    lastMessageAt: new Date(row.last_message_at),
    unreadCount: row.unread_count,
    participants: row.participant_rows.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName,
      avatarHash: participant.avatarHash,
    })),
  };
}

/**
 * The member's three folders. `Sent` is the conversations they started; `Archive` is their
 * own archived bucket. Only active participations are listed (design).
 */
export async function listConversations(sql: SQL, memberId: string): Promise<ConversationLists> {
  if (!MEMBER_ID.test(memberId)) {
    return { inbox: [], sent: [], archive: [] };
  }

  const rows = (await sql`
    SELECT
      c.id::text AS id,
      c.title,
      c.starter_id::text AS starter_id,
      p.folder,
      c.last_message_at,
      (
        SELECT count(*)::int
        FROM core.conversation_messages msg
        WHERE msg.conversation_id = c.id
          AND (p.last_read_message_id IS NULL OR msg.id > p.last_read_message_id)
      ) AS unread_count,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', m.id::text,
              'displayName', m.display_name,
              'avatarHash', m.avatar_hash
            )
            ORDER BY lower(m.display_name), m.id
          )
          FROM core.conversation_participants cp
          JOIN core.members m ON m.id = cp.member_id
          WHERE cp.conversation_id = c.id AND cp.state = 'active'
        ),
        '[]'::json
      ) AS participant_rows
    FROM core.conversations c
    JOIN core.conversation_participants p
      ON p.conversation_id = c.id
     AND p.member_id = ${memberId}
     AND p.state = 'active'
    ORDER BY c.last_message_at DESC, c.id DESC
  `) as SummaryRow[];

  const lists: {
    inbox: ConversationSummary[];
    sent: ConversationSummary[];
    archive: ConversationSummary[];
  } = { inbox: [], sent: [], archive: [] };

  for (const row of rows) {
    const summary = summaryFromRow(row, memberId);

    if (summary.folder === "archive") {
      lists.archive.push(summary);
    } else {
      // Inbox is every non-archived conversation; Sent is the starter's view of the same
      // conversations (design has one `folder` column, so Sent cannot be a fourth state).
      lists.inbox.push(summary);

      if (summary.folder === "sent") {
        lists.sent.push(summary);
      }
    }
  }

  return lists;
}

const SEARCH_MAX_LENGTH = 200;

/**
 * Searches only conversations where the viewer is an active participant. The participant join
 * is the authorisation boundary, so a matching message in someone else's conversation can never
 * appear in the result (task 2.3).
 */
export async function searchConversations(
  sql: SQL,
  memberId: string,
  query: string,
  locale: string | null = "en",
): Promise<readonly ConversationSummary[]> {
  const term = query.trim().slice(0, SEARCH_MAX_LENGTH);

  if (!MEMBER_ID.test(memberId) || term === "") {
    return [];
  }

  const config = textSearchConfig(locale);

  const rows = (await sql`
    SELECT
      c.id::text AS id,
      c.title,
      c.starter_id::text AS starter_id,
      p.folder,
      c.last_message_at,
      (
        SELECT count(*)::int
        FROM core.conversation_messages msg
        WHERE msg.conversation_id = c.id
          AND (p.last_read_message_id IS NULL OR msg.id > p.last_read_message_id)
      ) AS unread_count,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', m.id::text,
              'displayName', m.display_name,
              'avatarHash', m.avatar_hash
            )
            ORDER BY lower(m.display_name), m.id
          )
          FROM core.conversation_participants cp
          JOIN core.members m ON m.id = cp.member_id
          WHERE cp.conversation_id = c.id AND cp.state = 'active'
        ),
        '[]'::json
      ) AS participant_rows
    FROM core.conversations c
    JOIN core.conversation_participants p
      ON p.conversation_id = c.id
     AND p.member_id = ${memberId}
     AND p.state = 'active'
    WHERE c.title_search_vector @@ websearch_to_tsquery(${config}::regconfig, ${term})
       OR c.title_search_vector @@ websearch_to_tsquery('simple', ${term})
       OR EXISTS (
         SELECT 1
         FROM core.conversation_messages msg
         WHERE msg.conversation_id = c.id
           AND (
             msg.search_vector @@ websearch_to_tsquery(${config}::regconfig, ${term})
             OR msg.search_vector @@ websearch_to_tsquery('simple', ${term})
           )
       )
    ORDER BY c.last_message_at DESC, c.id DESC
  `) as SummaryRow[];

  return rows.map((row) => summaryFromRow(row, memberId));
}
