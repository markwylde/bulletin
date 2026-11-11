import type { SQL } from "bun";
import { NOTIFICATION_TYPES, type NotificationType } from "./repository.ts";

export const NOTIFICATION_CHANNELS = ["in_app", "email", "digest"] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export function isNotificationChannel(value: string): value is NotificationChannel {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export function isNotificationTypeValue(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export interface NotificationChannels {
  readonly in_app: boolean;
  readonly email: boolean;
  readonly digest: boolean;
}

/** Immediate channels are on by default; digests are opt-in. */
export function defaultChannelEnabled(channel: NotificationChannel): boolean {
  return channel !== "digest";
}

export function defaultNotificationChannels(): NotificationChannels {
  return { in_app: true, email: true, digest: false };
}

/** The member's effective settings for every type, with defaults filled in. */
export async function notificationPreferenceMatrix(
  sql: SQL,
  memberId: string,
): Promise<Readonly<Record<NotificationType, NotificationChannels>>> {
  const rows = (await sql`
    SELECT type, channel, enabled
    FROM core.notification_preferences
    WHERE member_id = ${memberId}
  `) as Array<{ type: string; channel: string; enabled: boolean }>;
  const matrix = Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, defaultNotificationChannels()]),
  ) as Record<NotificationType, NotificationChannels>;

  for (const row of rows) {
    if (!isNotificationTypeValue(row.type) || !isNotificationChannel(row.channel)) {
      continue;
    }

    matrix[row.type] = { ...matrix[row.type], [row.channel]: row.enabled };
  }

  return matrix;
}

export async function notificationChannels(
  sql: SQL,
  memberId: string,
  type: NotificationType,
): Promise<NotificationChannels> {
  const rows = (await sql`
    SELECT channel, enabled
    FROM core.notification_preferences
    WHERE member_id = ${memberId} AND type = ${type}
  `) as Array<{ channel: string; enabled: boolean }>;
  const channels: Record<NotificationChannel, boolean> = {
    in_app: true,
    email: true,
    digest: false,
  };

  for (const row of rows) {
    if (isNotificationChannel(row.channel)) {
      channels[row.channel] = row.enabled;
    }
  }

  return channels;
}

export async function setNotificationPreference(
  sql: SQL,
  memberId: string,
  type: NotificationType,
  channel: NotificationChannel,
  enabled: boolean,
): Promise<void> {
  await sql`
    INSERT INTO core.notification_preferences (member_id, type, channel, enabled)
    VALUES (${memberId}, ${type}, ${channel}, ${enabled})
    ON CONFLICT (member_id, type, channel) DO UPDATE
      SET enabled = EXCLUDED.enabled, updated_at = now()
  `;
}
