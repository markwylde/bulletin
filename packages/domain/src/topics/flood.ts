import type { SQL } from "bun";
import { loadMergedGroupSettings } from "../permissions/store.ts";

/** The member's effective flood-control interval (ADR 0005; `min` merge rule). */
export async function postFloodSeconds(sql: SQL, memberId: string): Promise<number> {
  const settings = await loadMergedGroupSettings(sql, memberId);
  const value = settings["posting.flood_control_seconds"];

  return typeof value === "number" ? value : 0;
}

/**
 * Seconds the member must wait before posting again, from the UNLOGGED posting buckets
 * (ADR 0003). The bucket key is the member id, which is not restricted PII.
 */
export async function postFloodWait(
  sql: SQL,
  memberId: string,
  options: { readonly seconds?: number; readonly now?: Date } = {},
): Promise<number> {
  const seconds = options.seconds ?? (await postFloodSeconds(sql, memberId));

  if (seconds <= 0) {
    return 0;
  }

  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - seconds * 1_000);
  const [row] = (await sql`
    SELECT max(window_start) AS last
    FROM core.rate_buckets
    WHERE key = ${`post:${memberId}`}
      AND window_start > ${since}
  `) as Array<{ last: Date | null }>;
  const last = row?.last;

  if (last === null || last === undefined) {
    return 0;
  }

  return Math.max(1, Math.ceil((last.getTime() + seconds * 1_000 - now.getTime()) / 1_000));
}

/** Records the accepted post in the member's flood bucket; never bumps a cache tag. */
export async function recordPostFlood(
  sql: SQL,
  memberId: string,
  now: Date = new Date(),
): Promise<void> {
  const windowStart = new Date(Math.floor(now.getTime() / 1_000) * 1_000);

  await sql`
    INSERT INTO core.rate_buckets (key, window_start, count)
    VALUES (${`post:${memberId}`}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE
      SET count = core.rate_buckets.count + 1
  `;
}
