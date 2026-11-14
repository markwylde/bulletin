import {
  type PrivacySettings,
  parsePrivacySettingsInput,
  readPrivacySettings,
} from "@bulletin/domain/privacy";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

export type PrivacySettingsSaveResult =
  | { readonly ok: true; readonly settings: PrivacySettings }
  | { readonly ok: false; readonly fields: readonly string[] };

export async function loadPrivacyRetention(sql: SQL): Promise<PrivacySettings> {
  return readPrivacySettings(sql);
}

export async function savePrivacyRetention(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<PrivacySettingsSaveResult> {
  const parsed = parsePrivacySettingsInput(input);

  if (!parsed.ok) {
    return { ok: false, fields: parsed.fields };
  }

  const value = parsed.value;
  const settings = await sql.begin(async (tx) => {
    await tx`SELECT 1 FROM core.privacy_settings WHERE id = 1 FOR UPDATE`;
    const before = await readPrivacySettings(tx);

    await tx`
      INSERT INTO core.privacy_settings (
        id, ip_log_retention_days, session_meta_retention_days,
        revoked_session_retention_days, access_log_retention_days,
        export_retention_days, ip_ban_retention_days, updated_at
      )
      VALUES (
        1, ${value.ipLogDays}, ${value.sessionMetaDays}, ${value.revokedSessionDays},
        ${value.accessLogDays}, ${value.exportDays}, ${value.ipBanDays}, now()
      )
      ON CONFLICT (id) DO UPDATE
      SET ip_log_retention_days = EXCLUDED.ip_log_retention_days,
          session_meta_retention_days = EXCLUDED.session_meta_retention_days,
          revoked_session_retention_days = EXCLUDED.revoked_session_retention_days,
          access_log_retention_days = EXCLUDED.access_log_retention_days,
          export_retention_days = EXCLUDED.export_retention_days,
          ip_ban_retention_days = EXCLUDED.ip_ban_retention_days,
          updated_at = now()
    `;

    const after = await readPrivacySettings(tx);

    await writeAdminLog(tx, {
      actorMemberId,
      action: "privacy.retention.update",
      targetType: "privacy_settings",
      targetId: "1",
      summary: { before, after },
    });

    return after;
  });

  return { ok: true, settings };
}
