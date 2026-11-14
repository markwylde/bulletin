import type { SQL } from "bun";

export interface PushDevice {
  readonly id: string;
  readonly label: string | null;
  readonly browserFamily: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface NewPushSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly label?: string | null;
  readonly userAgent?: string | null;
}

interface DeviceRow {
  readonly device_id: string;
  readonly label: string | null;
  readonly browser_family: string;
  readonly created_at: Date | string;
  readonly last_used_at: Date | string | null;
}

function device(row: DeviceRow): PushDevice {
  return {
    id: row.device_id,
    label: row.label,
    browserFamily: row.browser_family,
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
  };
}

/** Registers or refreshes one device for the session member; returns the device id. */
export async function savePushSubscription(
  sql: SQL,
  sessionToken: string,
  input: NewPushSubscription,
): Promise<string | null> {
  const [row] = (await sql`
    SELECT pii.save_push_subscription(
      ${sessionToken},
      ${input.endpoint},
      ${input.p256dh},
      ${input.auth},
      ${input.label ?? null},
      ${input.userAgent ?? null}
    ) AS device_id
  `) as Array<{ device_id: string | null }>;

  return row?.device_id ?? null;
}

/** The member's own device metadata. Endpoints and keys are never returned. */
export async function listPushDevices(
  sql: SQL,
  sessionToken: string,
): Promise<readonly PushDevice[]> {
  const rows = (await sql`
    SELECT device_id::text AS device_id, label, browser_family, created_at, last_used_at
    FROM pii.list_push_devices(${sessionToken})
  `) as DeviceRow[];

  return rows.map(device);
}

export async function deletePushDevice(
  sql: SQL,
  sessionToken: string,
  deviceId: string,
): Promise<boolean> {
  if (!/^\d+$/.test(deviceId)) {
    return false;
  }

  const [row] = (await sql`
    SELECT pii.delete_push_device(${sessionToken}, ${deviceId}::bigint) AS deleted
  `) as Array<{ deleted: boolean }>;

  return row?.deleted === true;
}

/** One subscription as the worker sees it, only through `pii.delivery_target`. */
export interface PushTarget {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

interface TargetRow {
  readonly id: string | number;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

function parseTargets(value: unknown): readonly PushTarget[] {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }

      const row = entry as Partial<TargetRow>;

      return (typeof row.id === "string" || typeof row.id === "number") &&
        typeof row.endpoint === "string" &&
        typeof row.p256dh === "string" &&
        typeof row.auth === "string"
        ? [
            {
              id: String(row.id),
              endpoint: row.endpoint,
              p256dh: row.p256dh,
              auth: row.auth,
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * The subscriptions for a push intent, or null when the channel/notification is no longer
 * eligible. This is the only worker path to endpoints and encryption keys (ADR 0012).
 */
export async function pushDeliveryTarget(
  sql: SQL,
  intentId: string,
): Promise<readonly PushTarget[] | null> {
  const [row] = (await sql`
    SELECT pii.delivery_target(${intentId}::bigint, 'push') AS target
  `) as Array<{ target: string | null }>;

  return row?.target === null || row?.target === undefined ? null : parseTargets(row.target);
}

export async function markPushSubscriptionUsed(
  sql: SQL,
  intentId: string,
  subscriptionId: string,
): Promise<void> {
  await sql`SELECT pii.mark_push_subscription_used(${intentId}::bigint, ${subscriptionId}::bigint)`;
}

export async function deleteDeadPushSubscription(
  sql: SQL,
  intentId: string,
  subscriptionId: string,
): Promise<boolean> {
  const [row] = (await sql`
    SELECT pii.delete_dead_push_subscription(
      ${intentId}::bigint, ${subscriptionId}::bigint
    ) AS deleted
  `) as Array<{ deleted: boolean }>;

  return row?.deleted === true;
}
