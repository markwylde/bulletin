import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "@bulletin/domain/events";
import {
  createPluginEventJobs,
  dispatchPluginEvent,
  type PluginEventJob,
  type PluginJobQueue,
  pluginEventQueue,
} from "./plugins.ts";

const EVENT: StoredEvent = {
  id: 99n,
  type: "topic.created",
  aggregateType: "topic",
  aggregateId: 5n,
  aggregateVersion: 1n,
  payloadIds: { topicId: "5", postId: "6", forumId: "2", authorId: "1" },
  createdAt: new Date(),
  publishedAt: null,
};

interface FakeQueue extends PluginJobQueue {
  readonly sent: Array<{ queue: string; payload: PluginEventJob; key: string }>;
  readonly worked: string[];
  run(queue: string, job: PluginEventJob): Promise<void>;
}

function fakeQueue(): FakeQueue {
  const handlers = new Map<
    string,
    (jobs: Array<{ id: string; data: PluginEventJob }>) => Promise<void>
  >();
  const queue: FakeQueue = {
    sent: [],
    worked: [],
    async send(name, payload, options) {
      queue.sent.push({ queue: name, payload, key: options.singletonKey });
    },
    async work(name, handler) {
      queue.worked.push(name);
      handlers.set(name, handler);
    },
    async offWork(name) {
      handlers.delete(name);
      queue.worked.splice(queue.worked.indexOf(name), 1);
    },
    async run(name, job) {
      const handler = handlers.get(name);

      if (handler === undefined) {
        throw new Error(`No worker for ${name}`);
      }

      await handler([{ id: "job-1", data: job }]);
    },
  };
  return queue;
}

describe("plugin event subscriber", () => {
  test("enqueues one job per subscribed plugin on its own queue", async () => {
    const queue = fakeQueue();
    const plugins = await dispatchPluginEvent({
      event: EVENT,
      subscriptions: [
        { pluginId: "welcome", eventType: "topic.created" },
        { pluginId: "tips", eventType: "topic.created" },
        { pluginId: "welcome", eventType: "topic.created" },
        { pluginId: "other", eventType: "post.created" },
      ],
      queue,
    });

    expect(plugins).toEqual(["tips", "welcome"]);
    expect(queue.sent.map((entry) => entry.queue)).toEqual([
      pluginEventQueue("tips"),
      pluginEventQueue("welcome"),
    ]);
    expect(queue.sent[0]?.key).toBe("plugin-event:99:tips");
    expect(queue.sent[0]?.payload.payloadIds).toEqual(EVENT.payloadIds);
  });

  test("consumes a per-plugin queue and forwards the event with the plugin id", async () => {
    const queue = fakeQueue();
    const requests: Array<{ url: string; body: unknown }> = [];
    const jobs = await createPluginEventJobs({
      // Only `readSubscriptions` is used during start.
      sql: (async () => [{ plugin_id: "welcome", event_type: "topic.created" }]) as never,
      queue,
      hostUrl: "http://plugin-host:3004",
      token: "secret",
      fetch: async (url, init) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response("{}");
      },
    });

    await jobs.start();
    expect(queue.worked).toEqual([pluginEventQueue("welcome")]);

    await queue.run(pluginEventQueue("welcome"), {
      eventId: "99",
      type: "topic.created",
      payloadIds: EVENT.payloadIds,
    });

    expect(requests).toEqual([
      {
        url: "http://plugin-host:3004/internal/events",
        body: {
          eventId: "99",
          type: "topic.created",
          payloadIds: EVENT.payloadIds,
          pluginIds: ["welcome"],
        },
      },
    ]);
  });

  test("a 200 response listing a plugin delivery failure still retries", async () => {
    const queue = fakeQueue();
    const jobs = await createPluginEventJobs({
      sql: (async () => [{ plugin_id: "welcome", event_type: "topic.created" }]) as never,
      queue,
      hostUrl: "http://plugin-host:3004",
      token: "secret",
      fetch: async () => Response.json({ delivered: 0, failures: ["welcome"] }),
    });
    await jobs.start();

    await expect(
      queue.run(pluginEventQueue("welcome"), {
        eventId: "99",
        type: "topic.created",
        payloadIds: {},
      }),
    ).rejects.toThrow("welcome");
  });

  test("a failed delivery throws so pg-boss retries that plugin only", async () => {
    const queue = fakeQueue();
    const jobs = await createPluginEventJobs({
      sql: (async () => [{ plugin_id: "welcome", event_type: "topic.created" }]) as never,
      queue,
      hostUrl: "http://plugin-host:3004",
      token: "secret",
      fetch: async () => new Response("{}", { status: 503 }),
    });
    await jobs.start();

    await expect(
      queue.run(pluginEventQueue("welcome"), {
        eventId: "99",
        type: "topic.created",
        payloadIds: {},
      }),
    ).rejects.toThrow("503");
  });
});
