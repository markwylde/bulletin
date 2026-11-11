import {
  DIGEST_FREQUENCIES,
  type DigestFrequency,
  digestFrequency,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationType,
  notificationPreferenceMatrix,
} from "@bulletin/domain/notifications";
import type { Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { BreadcrumbItem } from "../theme/render.ts";
import { NOTIFICATION_TYPE_LABELS } from "./notification-labels.ts";

const DIGEST_LABELS = {
  off: { labelKey: "notification.preferences.digestOff" },
  daily: { labelKey: "notification.preferences.digestDaily" },
  weekly: { labelKey: "notification.preferences.digestWeekly" },
} satisfies Record<DigestFrequency, { labelKey: string }>;

const CHANNEL_LABELS = {
  in_app: { labelKey: "notification.preferences.inApp" },
  email: { labelKey: "notification.preferences.email" },
  digest: { labelKey: "notification.preferences.digest" },
} satisfies Record<NotificationChannel, { labelKey: string }>;

export interface NotificationPreferencesPageInput {
  readonly sql: SQL;
  readonly memberId: string;
  readonly translate: Translator;
}

export interface NotificationPreferencesPageData {
  readonly title: string;
  readonly memberId: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly digestOptions: readonly {
      readonly value: DigestFrequency;
      readonly label: string;
      readonly selected: boolean;
    }[];
    readonly types: readonly {
      readonly type: NotificationType;
      readonly label: string;
      readonly channels: readonly {
        readonly channel: NotificationChannel;
        readonly label: string;
        readonly enabled: boolean;
      }[];
    }[];
  };
}

/** "Notification preferences": one switch per type and channel. */
export async function buildNotificationPreferencesPage(
  input: NotificationPreferencesPageInput,
): Promise<NotificationPreferencesPageData> {
  const [matrix, currentDigest] = await Promise.all([
    notificationPreferenceMatrix(input.sql, input.memberId),
    digestFrequency(input.sql, input.memberId),
  ]);
  const title = input.translate("notification.preferences.title");

  return {
    title,
    memberId: input.memberId,
    breadcrumbs: [
      { label: input.translate("account.title"), href: "/account" },
      { label: input.translate("notifications.title"), href: "/account/notifications" },
      { label: title, href: null },
    ],
    viewModel: {
      digestOptions: DIGEST_FREQUENCIES.map((frequency) => ({
        value: frequency,
        label: input.translate(DIGEST_LABELS[frequency].labelKey),
        selected: frequency === currentDigest,
      })),
      types: Object.entries(NOTIFICATION_TYPE_LABELS).map(([type, entry]) => ({
        type: type as NotificationType,
        label: input.translate(entry.labelKey),
        channels: NOTIFICATION_CHANNELS.map((channel) => ({
          channel,
          label: input.translate(CHANNEL_LABELS[channel].labelKey),
          enabled: matrix[type as NotificationType][channel],
        })),
      })),
    },
  };
}
