import { describe, expect, test } from "bun:test";
import {
  createPluginJobs,
  type PluginJobPayload,
  type PluginJobQueue,
  pluginJobQueue,
} from "./plugin-jobs.ts";

interface FakeQueue extends PluginJobQueue {
  readonly schedules: Array<{ queue: string; cron: string }>;
  readonly worked: string[];
  run(queue: string, payload: PluginJobPayload): Promise<void>;
}

function queue(): FakeQueue {
  const handlers = new Map<
    string,
    (jobs: ReadonlyArray<{ id: string; data: PluginJobPayload }>) => Promise<void>
  >();
  const value: FakeQueue = {
    schedules: [],
    worked: [],
    async send() {},
    async work(name, handler) {
      value.worked.push(name);
      handlers.set(name, handler);
    },
    async offWork(name) {
      handlers.delete(name);
      value.worked.splice(value.worked.indexOf(name), 1);
    },
    async schedule(name, cron) {
      value.schedules.push({ queue: name, cron });
    },
    async run(name, payload) {
      const handler = handlers.get(name);

      if (handler === undefined) {
        throw new Error(`no worker for ${name}`);
      }

      await handler([{ id: "1", data: payload }]);
    },
  };
  return value;
}

describe("plugin jobs", () => {
  test("namespaces queues by plugin and job name", () => {
    expect(pluginJobQueue("tips", "leaderboard")).toBe("plugin.tips.leaderboard");
  });

  test("registers scheduled and queued jobs and forwards payloads", async () => {
    const hookQueue = queue();
    const requests: unknown[] = [];
    const jobs = await createPluginJobs({
      sql: (async () => [
        { plugin_id: "tips", name: "leaderboard", schedule: "0 * * * *" },
        { plugin_id: "welcome", name: "greet", schedule: null },
      ]) as never,
      queue: hookQueue,
      hostUrl: "http://plugin-host:3004",
      token: "secret",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return new Response("{}");
      },
    });

    await jobs.start();
    expect(hookQueue.schedules).toEqual([{ queue: "plugin.tips.leaderboard", cron: "0 * * * *" }]);
    expect(hookQueue.worked).toEqual(["plugin.tips.leaderboard", "plugin.welcome.greet"]);

    await hookQueue.run("plugin.tips.leaderboard", { payload: { period: "hour" } });
    expect(requests).toEqual([
      { pluginId: "tips", name: "leaderboard", payload: { period: "hour" } },
    ]);
  });
});
