import { currentTraceparent, SpanKind, withSpan } from "@bulletin/config/tracing";
import type { EventType } from "@bulletin/domain/events";
import { type StoredEvent, toBigInt } from "@bulletin/domain/events";
import type { SQL } from "bun";

export interface JobQueue {
  send(
    queue: string,
    payload: Readonly<Record<string, string>>,
    options: { readonly singletonKey: string },
  ): Promise<void>;
}

export interface EventSubscriber {
  readonly name: string;
  readonly types: readonly EventType[] | "*";
}

export interface RelayOptions {
  readonly sql: SQL;
  readonly subscribers: readonly EventSubscriber[];
  readonly queue: JobQueue;
  readonly queueName?: string;
  readonly batchSize?: number;
}

export interface RelayResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

interface EventRow {
  readonly id: bigint | string;
  readonly type: EventType;
  readonly aggregate_type: string;
  readonly aggregate_id: bigint | string;
  readonly aggregate_version: bigint | string;
  readonly payload_ids: unknown;
  readonly created_at: Date | string;
  readonly trace_parent: string | null;
}

function parsePayloadIds(value: unknown): Record<string, string> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, string>;
    } catch {
      return {};
    }
  }

  return typeof value === "object" && value !== null ? (value as Record<string, string>) : {};
}

function rowToEvent(row: EventRow): StoredEvent {
  return {
    id: toBigInt(row.id),
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: toBigInt(row.aggregate_id),
    aggregateVersion: toBigInt(row.aggregate_version),
    payloadIds: parsePayloadIds(row.payload_ids),
    createdAt: new Date(row.created_at),
    publishedAt: null,
  };
}

function matches(subscriber: EventSubscriber, event: StoredEvent): boolean {
  return subscriber.types === "*" || subscriber.types.includes(event.type);
}

/**
 * Claims unpublished events with SKIP LOCKED, records one delivery per subscriber and
 * enqueues an idempotent job (singleton key event:subscriber) before marking the event
 * published. A failed subscriber leaves the event unpublished for a later retry.
 */
export function createRelay(options: RelayOptions): { runOnce(): Promise<RelayResult> } {
  const queueName = options.queueName ?? "domain-events";
  const batchSize = options.batchSize ?? 50;

  const runOnce = async (): Promise<RelayResult> => {
    let claimed = 0;
    let published = 0;
    let failed = 0;

    await options.sql.begin(async (tx) => {
      const rows = (await tx`
        SELECT id, type, aggregate_type, aggregate_id, aggregate_version, payload_ids, created_at,
               trace_parent
        FROM core.events
        WHERE published_at IS NULL
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      `) as EventRow[];

      for (const row of rows) {
        claimed += 1;
        const event = rowToEvent(row);
        // The relay span continues the trace of the write that emitted the event (ADR 0020).
        await withSpan(
          `outbox.relay ${event.type}`,
          async () => {
            const subscribers = options.subscribers.filter((subscriber) =>
              matches(subscriber, event),
            );
            let eventFailed = false;

            for (const subscriber of subscribers) {
              await tx`
            INSERT INTO core.event_deliveries (event_id, subscriber)
            VALUES (${event.id}, ${subscriber.name})
            ON CONFLICT DO NOTHING
          `;

              const deliveries = (await tx`
            SELECT enqueued_at
            FROM core.event_deliveries
            WHERE event_id = ${event.id} AND subscriber = ${subscriber.name}
          `) as Array<{ enqueued_at: Date | string | null }>;

              const delivery = deliveries[0];

              if (delivery === undefined) {
                eventFailed = true;
                failed += 1;
                continue;
              }

              if (delivery.enqueued_at !== null) {
                continue;
              }

              try {
                const traceparent = currentTraceparent();
                await options.queue.send(
                  queueName,
                  {
                    eventId: event.id.toString(),
                    subscriber: subscriber.name,
                    ...(traceparent === null ? {} : { traceparent }),
                  },
                  { singletonKey: `${event.id}:${subscriber.name}` },
                );

                await tx`
              UPDATE core.event_deliveries
              SET enqueued_at = now()
              WHERE event_id = ${event.id} AND subscriber = ${subscriber.name}
            `;

                await tx`
              INSERT INTO core.job_cursors (subscriber, last_event_id)
              VALUES (${subscriber.name}, ${event.id})
              ON CONFLICT (subscriber) DO UPDATE SET
                last_event_id = GREATEST(core.job_cursors.last_event_id, EXCLUDED.last_event_id),
                updated_at = now()
            `;
              } catch {
                eventFailed = true;
                failed += 1;
              }
            }

            if (!eventFailed) {
              await tx`
            UPDATE core.events
            SET published_at = now()
            WHERE id = ${event.id}
          `;
              published += 1;
            }
          },
          {
            kind: SpanKind.PRODUCER,
            traceparent: row.trace_parent,
            attributes: { "messaging.system": "pg-boss", "bulletin.event_id": event.id.toString() },
          },
        );
      }
    });

    return { claimed, published, failed };
  };

  return { runOnce };
}
