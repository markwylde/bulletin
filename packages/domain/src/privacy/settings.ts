import type { SQL } from "bun";

/** Configurable retention windows (ADR 0012; privacy-gdpr 2.1). */
export interface PrivacySettings {
  /** Post and login IP records older than this are deleted. */
  readonly ipLogDays: number;
  /** Session IP and browser metadata older than this is deleted. */
  readonly sessionMetaDays: number;
  /** Revoked sessions older than this are deleted. */
  readonly revokedSessionDays: number;
  /** PII audit-log rows older than this are deleted. */
  readonly accessLogDays: number;
  /** Export archives older than this are deleted. */
  readonly exportDays: number;
  /** Default duration for a new IP ban, and the age at which expired ban rows are purged. */
  readonly ipBanDays: number;
}

export const PRIVACY_SETTINGS_ID = 1;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3_650;

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  ipLogDays: 90,
  sessionMetaDays: 30,
  revokedSessionDays: 7,
  accessLogDays: 730,
  exportDays: 7,
  ipBanDays: 365,
};

interface PrivacySettingsRow {
  readonly ip_log_retention_days: number;
  readonly session_meta_retention_days: number;
  readonly revoked_session_retention_days: number;
  readonly access_log_retention_days: number;
  readonly export_retention_days: number;
  readonly ip_ban_retention_days: number;
}

export async function readPrivacySettings(sql: SQL): Promise<PrivacySettings> {
  const rows = (await sql`
    SELECT ip_log_retention_days, session_meta_retention_days,
      revoked_session_retention_days, access_log_retention_days,
      export_retention_days, ip_ban_retention_days
    FROM core.privacy_settings
    WHERE id = ${PRIVACY_SETTINGS_ID}
  `) as PrivacySettingsRow[];
  const row = rows[0];

  if (row === undefined) {
    return DEFAULT_PRIVACY_SETTINGS;
  }

  return {
    ipLogDays: row.ip_log_retention_days,
    sessionMetaDays: row.session_meta_retention_days,
    revokedSessionDays: row.revoked_session_retention_days,
    accessLogDays: row.access_log_retention_days,
    exportDays: row.export_retention_days,
    ipBanDays: row.ip_ban_retention_days,
  };
}

export type PrivacySettingsParseResult =
  | { readonly ok: true; readonly value: PrivacySettings }
  | { readonly ok: false; readonly fields: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retentionDays(value: unknown, fallback: number): number | null {
  if (value === undefined) {
    return fallback;
  }

  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_RETENTION_DAYS &&
    value <= MAX_RETENTION_DAYS
    ? value
    : null;
}

/** Validates a staff retention request body. Field ids match the form definition. */
export function parsePrivacySettingsInput(value: unknown): PrivacySettingsParseResult {
  if (!isRecord(value)) {
    return { ok: false, fields: ["form"] };
  }

  const fields: string[] = [];
  const ipLogDays = retentionDays(value.ipLogDays, DEFAULT_PRIVACY_SETTINGS.ipLogDays);
  const sessionMetaDays = retentionDays(
    value.sessionMetaDays,
    DEFAULT_PRIVACY_SETTINGS.sessionMetaDays,
  );
  const revokedSessionDays = retentionDays(
    value.revokedSessionDays,
    DEFAULT_PRIVACY_SETTINGS.revokedSessionDays,
  );
  const accessLogDays = retentionDays(value.accessLogDays, DEFAULT_PRIVACY_SETTINGS.accessLogDays);
  const exportDays = retentionDays(value.exportDays, DEFAULT_PRIVACY_SETTINGS.exportDays);
  const ipBanDays = retentionDays(value.ipBanDays, DEFAULT_PRIVACY_SETTINGS.ipBanDays);

  for (const [field, parsed] of [
    ["ipLogDays", ipLogDays],
    ["sessionMetaDays", sessionMetaDays],
    ["revokedSessionDays", revokedSessionDays],
    ["accessLogDays", accessLogDays],
    ["exportDays", exportDays],
    ["ipBanDays", ipBanDays],
  ] as const) {
    if (parsed === null) {
      fields.push(field);
    }
  }

  if (fields.length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    value: {
      ipLogDays: ipLogDays ?? DEFAULT_PRIVACY_SETTINGS.ipLogDays,
      sessionMetaDays: sessionMetaDays ?? DEFAULT_PRIVACY_SETTINGS.sessionMetaDays,
      revokedSessionDays: revokedSessionDays ?? DEFAULT_PRIVACY_SETTINGS.revokedSessionDays,
      accessLogDays: accessLogDays ?? DEFAULT_PRIVACY_SETTINGS.accessLogDays,
      exportDays: exportDays ?? DEFAULT_PRIVACY_SETTINGS.exportDays,
      ipBanDays: ipBanDays ?? DEFAULT_PRIVACY_SETTINGS.ipBanDays,
    },
  };
}
