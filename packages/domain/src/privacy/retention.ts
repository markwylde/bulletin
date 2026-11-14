import type { SQL } from "bun";
import type { PrivacySettings } from "./settings.ts";

export interface CoreRetentionResult {
  readonly revokedSessions: number;
  readonly ipBans: number;
}

/** Purges core.sessions and core.ip_bans; the pii categories live behind definer functions. */
export async function purgeExpiredCoreRetention(
  sql: SQL,
  settings: PrivacySettings,
  now: Date = new Date(),
): Promise<CoreRetentionResult> {
  const revokedBefore = new Date(
    now.getTime() - settings.revokedSessionDays * 24 * 60 * 60 * 1_000,
  );

  const sessions = (await sql`
    DELETE FROM core.sessions
    WHERE revoked_at IS NOT NULL
      AND revoked_at < ${revokedBefore}
    RETURNING id
  `) as Array<{ id: string }>;
  const bans = (await sql`
    DELETE FROM core.ip_bans
    WHERE expires_at IS NOT NULL
      AND expires_at <= ${now}
    RETURNING id
  `) as Array<{ id: string }>;

  return { revokedSessions: sessions.length, ipBans: bans.length };
}
