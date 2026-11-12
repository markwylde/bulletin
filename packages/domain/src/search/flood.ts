import type { SQL } from "bun";
import { principalMemberId, type ViewerPrincipal } from "../permissions/principal.ts";
import { loadMergedGroupSettings } from "../permissions/store.ts";

/** The viewer's effective search interval; `members.search_flood_seconds` uses `min`. */
export async function searchFloodSeconds(sql: SQL, principal: ViewerPrincipal): Promise<number> {
  const settings = await loadMergedGroupSettings(sql, principal);
  const value = settings["members.search_flood_seconds"];

  return typeof value === "number" && value > 0 ? value : 0;
}

export interface SearchFloodOptions {
  /** A stable guest identity (the guest cookie); members are keyed by member ID. */
  readonly viewerKey?: string;
  /** Override the group setting, used by callers that already loaded it. */
  readonly seconds?: number;
  readonly now?: Date;
}

export type SearchFloodOutcome =
  | { readonly ok: true; readonly retryAfterSeconds: 0 }
  | { readonly ok: false; readonly retryAfterSeconds: number };

function searchFloodKey(principal: ViewerPrincipal, viewerKey: string | undefined): string {
  return `search:${principalMemberId(principal) ?? viewerKey ?? "guest"}`;
}

/**
 * Enforces the group's search interval from the UNLOGGED rate buckets (ADR 0003, 0005).
 * A refused search is not recorded, so the wait time only counts accepted searches.
 */
export async function consumeSearchFlood(
  sql: SQL,
  principal: ViewerPrincipal,
  options: SearchFloodOptions = {},
): Promise<SearchFloodOutcome> {
  const seconds = options.seconds ?? (await searchFloodSeconds(sql, principal));

  if (seconds <= 0) {
    return { ok: true, retryAfterSeconds: 0 };
  }

  const now = options.now ?? new Date();
  const key = searchFloodKey(principal, options.viewerKey);
  const since = new Date(now.getTime() - seconds * 1_000);
  const [row] = (await sql`
    SELECT max(window_start) AS last
    FROM core.rate_buckets
    WHERE key = ${key}
      AND window_start > ${since}
  `) as Array<{ last: Date | null }>;
  const last = row?.last;

  if (last !== null && last !== undefined) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((last.getTime() + seconds * 1_000 - now.getTime()) / 1_000),
      ),
    };
  }

  const windowStart = new Date(Math.floor(now.getTime() / 1_000) * 1_000);
  await sql`
    INSERT INTO core.rate_buckets (key, window_start, count)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE
      SET count = core.rate_buckets.count + 1
  `;

  return { ok: true, retryAfterSeconds: 0 };
}
