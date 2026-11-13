import type { Logger } from "@bulletin/config";
import type { StoredEvent } from "@bulletin/domain/events";
import type { SQL } from "bun";

/**
 * Plugin event subscribers (ADR 0009, 0011). The core relay sees one `plugins` subscriber;
 * this module fans each event out to a per-plugin `plugin.<id>.events` pg-boss queue, so one
 * plugin's retries or dead letters never block another plugin or the core subscribers.
 */

export interface PluginSubscription {
  readonly pluginId: string;
  readonly eventType: string;
}

export interface PluginEventJob {
  readonly eventId: string;
  readonly type: string;
  readonly payloadIds: Readonly<Record<string, string>>;
}

export interface PluginJobQueue {
  send(
    queue: string,
    payload: PluginEventJob,
    options: { readonly singletonKey: string },
  ): Promise<void>;
  work(
    queue: string,
    handler: (
      jobs: ReadonlyArray<{ readonly id: string; readonly data: PluginEventJob }>,
    ) => Promise<void>,
  ): Promise<void>;
  offWork(queue: string): Promise<void>;
  ensureQueue?(queue: string): Promise<void>;
}

export function pluginEventQueue(pluginId: string): string {
  return `plugin.${pluginId}.events`;
}

/** One job per subscribed plugin; a plugin without a subscription is never enqueued. */
export async function dispatchPluginEvent(options: {
  readonly event: StoredEvent;
  readonly subscriptions: readonly PluginSubscription[];
  readonly queue: PluginJobQueue;
  readonly logger?: Logger;
}): Promise<readonly string[]> {
  const pluginIds = [
    ...new Set(
      options.subscriptions
        .filter((subscription) => subscription.eventType === options.event.type)
        .map((subscription) => subscription.pluginId),
    ),
  ].sort();

  for (const pluginId of pluginIds) {
    await options.queue.send(
      pluginEventQueue(pluginId),
      {
        eventId: options.event.id.toString(),
        type: options.event.type,
        payloadIds: options.event.payloadIds,
      },
      { singletonKey: `plugin-event:${options.event.id.toString()}:${pluginId}` },
    );
  }

  options.logger?.debug("plugin.events_dispatched", {
    eventId: options.event.id.toString(),
    plugins: pluginIds.length,
  });
  return pluginIds;
}

export interface PluginEventJobsOptions {
  readonly sql: SQL;
  readonly ensureQueue?: (queue: string) => Promise<void>;
  readonly queue: PluginJobQueue;
  readonly hostUrl: string;
  readonly token: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly logger?: Logger;
}

export interface PluginEventJobs {
  /** Loads the current subscriptions and starts one consumer per plugin queue. */
  start(): Promise<void>;
  dispatch(event: StoredEvent): Promise<readonly string[]>;
  stop(): Promise<void>;
}

async function readSubscriptions(sql: SQL): Promise<readonly PluginSubscription[]> {
  const rows = (await sql`
    SELECT s.plugin_id, s.event_type
    FROM core.plugin_event_subscriptions s
    JOIN core.plugins p ON p.plugin_id = s.plugin_id
    JOIN core.feature_flags f ON f.key = 'plugins'
    WHERE p.enabled AND p.state = 'active' AND f.default_value
  `) as Array<{ plugin_id: string; event_type: string }>;

  return rows.map((row) => ({ pluginId: row.plugin_id, eventType: row.event_type }));
}

/** Creates the core `plugins` subscriber and per-plugin consumers. */
export async function createPluginEventJobs(
  options: PluginEventJobsOptions,
): Promise<PluginEventJobs> {
  const request = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const started: string[] = [];
  let subscriptions: readonly PluginSubscription[] = [];

  return {
    async start() {
      subscriptions = await readSubscriptions(options.sql);
      const pluginIds = [...new Set(subscriptions.map((entry) => entry.pluginId))];

      for (const pluginId of pluginIds) {
        const queue = pluginEventQueue(pluginId);
        await options.ensureQueue?.(queue);
        await options.queue.work(queue, async (jobs) => {
          for (const job of jobs) {
            const response = await request(`${options.hostUrl}/internal/events`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${options.token}`,
              },
              body: JSON.stringify({
                ...job.data,
                pluginIds: [pluginId],
              }),
            });

            if (!response.ok) {
              throw new Error(`Plugin event delivery failed: ${response.status}`);
            }

            const result = (await response.json().catch(() => null)) as {
              failures?: unknown;
            } | null;

            if (Array.isArray(result?.failures) && result.failures.includes(pluginId)) {
              // The host answered 200 but retained a per-plugin failure: leave the pg-boss
              // job un-acked so only that plugin's queue retries.
              throw new Error(`Plugin event delivery failed for ${pluginId}`);
            }
          }
        });
        started.push(queue);
      }
    },

    async dispatch(event) {
      return dispatchPluginEvent({
        event,
        subscriptions,
        queue: options.queue,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
    },

    async stop() {
      for (const queue of started.splice(0)) {
        await options.queue.offWork(queue);
      }
    },
  };
}
