import type { SQL } from "bun";

/**
 * Read-path visits (ADR 0006): the member overlay request and the guest beacon record views,
 * presence and read markers here. Nothing in this module bumps a content cache tag.
 */

/** Views dedupe per topic, viewer and half-hour bucket (topics-posts). */
export const VIEW_DEDUPE_MS = 30 * 60 * 1_000;

/** Presence is upserted at most once a minute per viewer (member-profiles). */
export const PRESENCE_REFRESH_MS = 60 * 1_000;

/**
 * How long a presence row lives (design retention table: 15 minutes). The worker maintenance
 * job deletes older rows; presence is a derived record, never durable.
 */
export const VISIT_BUFFER_RETENTION_MS = 15 * 60 * 1_000;

/** Guest beacons per IP per minute (ADR 0003 flood control). */
export const BEACON_RATE_LIMIT = 60;
export const BEACON_RATE_WINDOW_MS = 60 * 1_000;

/**
 * Rate-limit identities are keyed digests that rotate daily (ADR 0012): `core.rate_buckets` is
 * readable by the app roles, so a raw IP must never be its key.
 */
export const RATE_KEY_ROTATION_MS = 24 * 60 * 60 * 1_000;
/** How long a counter's window is kept before the next call expires it (ADR 0012 retention). */
export const RATE_BUCKET_RETENTION_MS = 24 * 60 * 60 * 1_000;

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
  /** The `created_at` of the last post on the page; timestamps survive merge and split. */
  readonly lastReadAt?: Date;
  /** The last post on the page, kept for permalinks and history. */
  readonly lastReadPostId?: string;
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
    INSERT INTO core.topic_view_buffer (topic_id, viewer_key, bucket, recorded_at)
    VALUES (${topicId}, ${viewerKey}, ${bucketStart(now, VIEW_DEDUPE_MS)}, ${now})
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
      const lastReadAt = input.lastReadAt ?? now;
      const lastReadPostId =
        input.lastReadPostId !== undefined && /^\d+$/.test(input.lastReadPostId)
          ? input.lastReadPostId
          : null;

      await sql`
        INSERT INTO core.topic_reads (member_id, topic_id, last_read_at, last_read_post_id)
        VALUES (${input.memberId}, ${context.id}, ${lastReadAt}, ${lastReadPostId})
        ON CONFLICT (member_id, topic_id) DO UPDATE
          SET last_read_at = GREATEST(
                core.topic_reads.last_read_at,
                EXCLUDED.last_read_at
              ),
              last_read_post_id = CASE
                WHEN ${lastReadPostId}::bigint IS NULL THEN core.topic_reads.last_read_post_id
                WHEN EXCLUDED.last_read_at >= core.topic_reads.last_read_at
                  THEN EXCLUDED.last_read_post_id
                ELSE core.topic_reads.last_read_post_id
              END
      `;
    }
  }

  if (input.memberId === undefined || input.memberId === null || input.topics === undefined) {
    return { unread: [] };
  }

  // Only the topic being read is implicitly read; a forum's ID can equal a topic's ID.
  const candidates =
    context.kind === "topic"
      ? input.topics.filter((topicId) => topicId !== context.id)
      : input.topics;

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

export interface RateLimitKeyInput {
  readonly secret: string;
  /** The limit's purpose, e.g. `beacon`. */
  readonly scope: string;
  /** The raw identity (an IP, a member id); it is digested, never stored. */
  readonly identity: string;
  readonly now?: Date;
  readonly rotationMs?: number;
}

/** A keyed digest that rotates daily, so stored counters cannot be reversed into an IP. */
export function rateLimitKey(input: RateLimitKeyInput): string {
  const rotation = Math.floor(
    (input.now ?? new Date()).getTime() / (input.rotationMs ?? RATE_KEY_ROTATION_MS),
  );
  const digest = new Bun.CryptoHasher("sha256", input.secret)
    .update(`${input.scope}|${rotation}|${input.identity}`)
    .digest("hex");

  return `${input.scope}:${rotation}:${digest}`;
}

export interface VisitExpiryOptions {
  readonly now?: Date;
  readonly retentionMs?: number;
}

export interface VisitExpiryResult {
  readonly presence: number;
  readonly views: number;
}

/**
 * Expires derived visit buffers (ADR 0012). Presence rows go after the retention window. A
 * view row is kept until its 30-minute dedupe bucket has closed: deleting it earlier (its
 * `bucket` is the rounded start) would let a second visit late in the same bucket insert a
 * duplicate view. `recorded_at` keeps the true visit time on the row. Runs from the workers
 * maintenance schedule; fresh visits are untouched.
 */
export async function expireVisitBuffers(
  sql: SQL,
  options: VisitExpiryOptions = {},
): Promise<VisitExpiryResult> {
  const now = options.now ?? new Date();
  const presenceCutoff = new Date(
    now.getTime() - (options.retentionMs ?? VISIT_BUFFER_RETENTION_MS),
  );
  const bucketCutoff = new Date(now.getTime() - VIEW_DEDUPE_MS);
  const presence = (await sql`
    DELETE FROM core.presence
    WHERE last_seen < ${presenceCutoff}
    RETURNING 1
  `) as unknown[];
  const views = (await sql`
    DELETE FROM core.topic_view_buffer
    WHERE bucket <= ${bucketCutoff}
    RETURNING 1
  `) as unknown[];

  return { presence: presence.length, views: views.length };
}

export interface RateBucketOptions {
  readonly scope: string;
  /** The raw identity (an IP, a member id); only its rotating digest reaches `core`. */
  readonly identity: string;
  readonly secret: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: Date;
  readonly retentionMs?: number;
}

/** Counts one hit in the UNLOGGED bucket; false when the key exceeded `limit` this window. */
export async function consumeRateBucket(sql: SQL, options: RateBucketOptions): Promise<boolean> {
  const now = options.now ?? new Date();
  const key = rateLimitKey({
    secret: options.secret,
    scope: options.scope,
    identity: options.identity,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const rows = (await sql`
    INSERT INTO core.rate_buckets (key, window_start, count)
    VALUES (${key}, ${bucketStart(now, options.windowMs)}, 1)
    ON CONFLICT (key, window_start) DO UPDATE
      SET count = core.rate_buckets.count + 1
    RETURNING count
  `) as Array<{ count: number }>;
  const count = rows[0]?.count ?? 1;

  // Derived counters never outlive their retention window (ADR 0012), even though the table is
  // UNLOGGED and the jobs' purge is not wired yet.
  const cutoff = new Date(now.getTime() - (options.retentionMs ?? RATE_BUCKET_RETENTION_MS));
  await sql`DELETE FROM core.rate_buckets WHERE window_start < ${cutoff}`;

  return count <= options.limit;
}
