import type { SQL } from "bun";
import { RATE_BUCKET_RETENTION_MS, rateLimitKey } from "../visits/index.ts";

/** Both limits count per minute (ADR 0016); admins tune them on the board settings screen. */
export const API_RATE_WINDOW_MS = 60 * 1_000;

export interface ApiRateLimits {
  readonly keyPerMinute: number;
  readonly ipPerMinute: number;
}

export interface ApiRateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  /** Standard `RateLimit-*` values for the limiting bucket. */
  readonly headers: Readonly<Record<string, string>>;
}

interface WindowResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly limit: number;
  readonly resetSeconds: number;
}

function windowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / API_RATE_WINDOW_MS) * API_RATE_WINDOW_MS);
}

/**
 * A sliding window approximated by two fixed windows: the current bucket plus the decaying
 * previous bucket. One atomic upsert per request keeps concurrent workers from undercounting
 * (ADR 0003, 0016).
 */
async function consumeWindow(
  sql: SQL,
  input: {
    readonly scope: string;
    readonly identity: string;
    readonly secret: string;
    readonly limit: number;
    readonly now: Date;
  },
): Promise<WindowResult> {
  const start = windowStart(input.now);
  const previousStart = new Date(start.getTime() - API_RATE_WINDOW_MS);
  const key = rateLimitKey({
    secret: input.secret,
    scope: input.scope,
    identity: input.identity,
    now: input.now,
  });

  const [current] = (await sql`
    INSERT INTO core.rate_buckets (key, window_start, count)
    VALUES (${key}, ${start}, 1)
    ON CONFLICT (key, window_start) DO UPDATE
      SET count = core.rate_buckets.count + 1
    RETURNING count
  `) as Array<{ count: number }>;
  const [previous] = (await sql`
    SELECT count
    FROM core.rate_buckets
    WHERE key = ${key} AND window_start = ${previousStart}
  `) as Array<{ count: number }>;

  const elapsed = input.now.getTime() - start.getTime();
  const decay = Math.max(0, 1 - elapsed / API_RATE_WINDOW_MS);
  const weighted = (previous?.count ?? 0) * decay + (current?.count ?? 1);
  const resetSeconds = Math.max(
    1,
    Math.ceil((start.getTime() + API_RATE_WINDOW_MS - input.now.getTime()) / 1_000),
  );

  return {
    allowed: weighted <= input.limit,
    remaining: Math.max(0, Math.floor(input.limit - weighted)),
    limit: input.limit,
    resetSeconds,
  };
}

/**
 * Counts one `/api/v1` request against the key (when authenticated) and the client IP.
 * The strictest bucket supplies the headers; any exhausted bucket returns 429 with the
 * longest wait so a client cannot retry into another bucket's refusal.
 */
export async function consumeApiRateLimit(
  sql: SQL,
  input: {
    readonly keyId: string | null;
    readonly ip: string | null;
    readonly secret: string;
    readonly limits: ApiRateLimits;
    readonly now?: Date;
  },
): Promise<ApiRateLimitResult> {
  const now = input.now ?? new Date();
  const results: WindowResult[] = [];

  if (input.keyId !== null) {
    results.push(
      await consumeWindow(sql, {
        scope: "api_key",
        identity: input.keyId,
        secret: input.secret,
        limit: input.limits.keyPerMinute,
        now,
      }),
    );
  }

  results.push(
    await consumeWindow(sql, {
      scope: "api_ip",
      identity: input.ip ?? "unknown",
      secret: input.secret,
      limit: input.limits.ipPerMinute,
      now,
    }),
  );

  await sql`
    DELETE FROM core.rate_buckets
    WHERE window_start < ${new Date(now.getTime() - RATE_BUCKET_RETENTION_MS)}
  `;

  const limiting = results.reduce((strictest, result) =>
    result.remaining < strictest.remaining ? result : strictest,
  );
  const denied = results.filter((result) => !result.allowed);
  const retryAfterSeconds =
    denied.length === 0
      ? limiting.resetSeconds
      : Math.max(...denied.map((result) => result.resetSeconds));

  return {
    allowed: denied.length === 0,
    retryAfterSeconds,
    headers: {
      "RateLimit-Limit": String(limiting.limit),
      "RateLimit-Remaining": String(limiting.remaining),
      "RateLimit-Reset": String(limiting.resetSeconds),
    },
  };
}
