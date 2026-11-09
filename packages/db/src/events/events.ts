import type { SQL } from "bun";
import { type DomainEvent, EVENT_CATALOG, type EventType } from "./catalog.ts";

export interface StoredEvent {
  readonly id: bigint;
  readonly type: EventType;
  readonly aggregateType: string;
  readonly aggregateId: bigint;
  readonly aggregateVersion: bigint;
  readonly payloadIds: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export class EventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventError";
  }
}

export function toBigInt(value: bigint | number | string): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function serializeIds<T extends EventType>(payload: DomainEvent<T>["payloadIds"]): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key,
        typeof value === "bigint" ? value.toString() : String(value),
      ]),
    ),
  );
}

/**
 * Inserts an event into the outbox. It must be called with the same transaction as the
 * domain change, so a rolled-back change produces no event (ADR 0011).
 */
export async function emit<T extends EventType>(tx: SQL, event: DomainEvent<T>): Promise<bigint> {
  const catalogEntry = EVENT_CATALOG[event.type];
  const expected = catalogEntry.payloadIds;
  const actual = Object.keys(event.payloadIds);

  if (actual.length !== expected.length || expected.some((key) => !actual.includes(key))) {
    throw new EventError(`Payload IDs for ${event.type} must be exactly: ${expected.join(", ")}`);
  }

  const rows = (await tx`
    INSERT INTO core.events (
      type,
      aggregate_type,
      aggregate_id,
      aggregate_version,
      payload_ids
    ) VALUES (
      ${event.type},
      ${catalogEntry.aggregateType},
      ${event.aggregateId},
      ${event.aggregateVersion},
      ${serializeIds(event.payloadIds)}::jsonb
    )
    RETURNING id
  `) as Array<{ id: bigint | string }>;

  const row = rows[0];

  if (row === undefined) {
    throw new EventError("Event insert returned no row");
  }

  return toBigInt(row.id);
}

export function isStaleEvent(
  event: Pick<StoredEvent, "aggregateVersion">,
  lastSeenVersion: bigint,
): boolean {
  return event.aggregateVersion <= lastSeenVersion;
}

interface StoredEventRow {
  readonly id: bigint | string;
  readonly type: EventType;
  readonly aggregate_type: string;
  readonly aggregate_id: bigint | string;
  readonly aggregate_version: bigint | string;
  readonly payload_ids: unknown;
  readonly created_at: Date | string;
  readonly published_at: Date | string | null;
}

function parseIds(value: unknown): Record<string, string> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, string>;
    } catch {
      return {};
    }
  }

  return typeof value === "object" && value !== null ? (value as Record<string, string>) : {};
}

export async function loadEvent(sql: SQL, id: bigint): Promise<StoredEvent | null> {
  const rows = (await sql`
    SELECT id, type, aggregate_type, aggregate_id, aggregate_version, payload_ids,
           created_at, published_at
    FROM core.events
    WHERE id = ${id}
  `) as StoredEventRow[];

  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  return {
    id: toBigInt(row.id),
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: toBigInt(row.aggregate_id),
    aggregateVersion: toBigInt(row.aggregate_version),
    payloadIds: parseIds(row.payload_ids),
    createdAt: new Date(row.created_at),
    publishedAt: row.published_at === null ? null : new Date(row.published_at),
  };
}
