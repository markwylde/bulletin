import type { SQL } from "bun";

/**
 * Read-path visits (ADR 0006): the member overlay request and the guest beacon record views,
 * presence and read markers here. Nothing in this module bumps a content cache tag.
 */

/** Views dedupe per topic, viewer and half-hour bucket (topics-posts). */
export const VIEW_DEDUPE_MS = 30 * 60 * 1_000;

/** Presence is upserted at most once a minute per viewer (member-profiles). */
export const PRESENCE_REFRESH_MS = 60 * 1_000;

/** Guest beacons per IP per minute (ADR 0003 flood control). */
export const BEACON_RATE_LIMIT = 60;
export const BEACON_RATE_WINDOW_MS = 60 * 1_000;

/** The pseudonymous guest cookie used for presence and view dedupe (ADR 0012). */
export const GUEST_COOKIE_NAME = "bl_guest";
export const GUEST_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Same `__Host-` rule as the session cookies (ADR 0018). */
export function guestCookieName(nodeEnv: "development" | "test" | "production"): string {
  return nodeEnv === "production" ? "__Host-bl_guest" : GUEST_COOKIE_NAME;
}

const GUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTEXT = /^(topic|forum):([1-9]\d{0,18})$/;

export interface VisitContext {
  readonly kind: "topic" | "forum";
  readonly id: string;
}

export function parseVisitContext(ctx: string): VisitContext | null {
  const match = CONTEXT.exec(ctx.trim());

  if (match === null) {
    return null;
  }

  return { kind: match[1] as "topic" | "forum", id: match[2] as string };
}

/** Accepts only the ids the page actually rendered, so the overlay cannot scan the board. */
export function parseTopicIds(topics: unknown): readonly string[] {
  if (!Array.isArray(topics)) {
    return [];
  }

  const ids: string[] = [];

  for (const value of topics.slice(0, 100)) {
    if (typeof value === "string" && /^[1-9]\d{0,18}$/.test(value)) {
      ids.push(value);
    }
  }

  return [...new Set(ids)];
}

export function memberViewerKey(memberId: string): string {
  return `member:${memberId}`;
}

export function guestViewerKey(guestId: string): string {
  return `guest:${guestId}`;
}

export function isGuestId(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && GUEST_ID.test(value);
}

export interface VisitInput {
  /** ADR 0012: only this pseudonymous viewer key enters the buffers, never the member id. */
  readonly viewerKey: string;
  readonly ctx: string;
  /** Topic ids on the page (a list page), used for unread markers. */
  readonly topics?: readonly string[];
  /** Only a member principal owns read markers and unread state. */
  readonly memberId?: string | null;
  readonly now?: Date;
}

export interface VisitResult {
  /** Topic ids from `topics` that the member has not read yet. */
  readonly unread: readonly string[];
}

function bucketStart(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

async function recordView(sql: SQL, topicId: string, viewerKey: string, now: Date): Promise<void> {
  await sql`
    INSERT INTO core.topic_view_buffer (topic_id, viewer_key, bucket)
    VALUES (${topicId}, ${viewerKey}, ${bucketStart(now, VIEW_DEDUPE_MS)})
    ON CONFLICT (topic_id, viewer_key, bucket) DO NOTHING
  `;
}

async function recordPresence(
  sql: SQL,
  viewerKey: string,
  location: string,
  now: Date,
): Promise<void> {
  await sql`
    INSERT INTO core.presence (viewer_key, location, last_seen)
    VALUES (${viewerKey}, ${location}, ${now})
    ON CONFLICT (viewer_key) DO UPDATE
      SET location = EXCLUDED.location, last_seen = EXCLUDED.last_seen
      WHERE core.presence.last_seen <= EXCLUDED.last_seen - interval '1 minute'
  `;
}

/**
 * Records one visit: a topic view, presence at the context forum, and (for members) the read
 * marker for the topic and the unread set of the topics on the page. Never touches cache tags.
 */
export async function recordVisit(sql: SQL, input: VisitInput): Promise<VisitResult> {
  const now = input.now ?? new Date();
  const context = parseVisitContext(input.ctx);

  if (context === null) {
    return { unread: [] };
  }

  // The location of a topic is its forum; without a forum table yet, use the topic context.
  const location = context.kind === "forum" ? `forum:${context.id}` : input.ctx;

  await recordPresence(sql, input.viewerKey, location, now);

  if (context.kind === "topic") {
    await recordView(sql, context.id, input.viewerKey, now);

    if (input.memberId !== undefined && input.memberId !== null) {
      await sql`
        INSERT INTO core.topic_reads (member_id, topic_id, last_read_at)
        VALUES (${input.memberId}, ${context.id}, ${now})
        ON CONFLICT (member_id, topic_id) DO UPDATE
          SET last_read_at = GREATEST(core.topic_reads.last_read_at, EXCLUDED.last_read_at)
      `;
    }
  }

  if (input.memberId === undefined || input.memberId === null || input.topics === undefined) {
    return { unread: [] };
  }

  const candidates = input.topics.filter((topicId) => topicId !== context.id);

  if (candidates.length === 0) {
    return { unread: [] };
  }

  const read = (await sql`
    SELECT topic_id::text AS topic_id
    FROM core.topic_reads
    WHERE member_id = ${input.memberId}
      AND topic_id = ANY(${`{${candidates.join(",")}}`}::bigint[])
  `) as Array<{ topic_id: string }>;
  const readIds = new Set(read.map((row) => row.topic_id));

  return { unread: candidates.filter((topicId) => !readIds.has(topicId)) };
}

export interface RateBucketOptions {
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: Date;
}

/** Counts one hit in the UNLOGGED bucket; false when the key exceeded `limit` this window. */
export async function consumeRateBucket(sql: SQL, options: RateBucketOptions): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = (await sql`
    INSERT INTO core.rate_buckets (key, window_start, count)
    VALUES (${options.key}, ${bucketStart(now, options.windowMs)}, 1)
    ON CONFLICT (key, window_start) DO UPDATE
      SET count = core.rate_buckets.count + 1
    RETURNING count
  `) as Array<{ count: number }>;
  const count = rows[0]?.count ?? 1;

  return count <= options.limit;
}
