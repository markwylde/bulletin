import type { Logger } from "@bulletin/config";
import type { SQL } from "bun";

/** Scheduled and queued plugin jobs, one pg-boss queue per `plugin.<id>.<name>` (ADR 0009). */

export interface PluginJob {
  readonly pluginId: string;
  readonly name: string;
  readonly schedule: string | null;
}

export interface PluginJobPayload {
  readonly payload: Readonly<Record<string, unknown>>;
}

export function pluginJobQueue(pluginId: string, name: string): string {
  return `plugin.${pluginId}.${name}`;
}

export interface PluginJobQueue {
  send(
    queue: string,
    payload: PluginJobPayload,
    options: { readonly singletonKey: string },
  ): Promise<void>;
  work(
    queue: string,
    handler: (
      jobs: ReadonlyArray<{ readonly id: string; readonly data: PluginJobPayload }>,
    ) => Promise<void>,
  ): Promise<void>;
  offWork(queue: string): Promise<void>;
  schedule(queue: string, cron: string, data: PluginJobPayload): Promise<void>;
}

export interface PluginJobOptions {
  readonly sql: SQL;
  readonly queue: PluginJobQueue;
  readonly hostUrl: string;
  readonly token: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly logger?: Logger;
}

export interface PluginJobs {
  start(): Promise<void>;
  enqueue(job: PluginJob, payload: Readonly<Record<string, unknown>>): Promise<void>;
  stop(): Promise<void>;
}

async function readJobs(sql: SQL): Promise<readonly PluginJob[]> {
  const rows = (await sql`
    SELECT plugin_id, name, schedule FROM core.plugin_jobs
  `) as Array<{ plugin_id: string; name: string; schedule: string | null }>;

  return rows.map((row) => ({ pluginId: row.plugin_id, name: row.name, schedule: row.schedule }));
}

export async function createPluginJobs(options: PluginJobOptions): Promise<PluginJobs> {
  const request = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const jobs: PluginJob[] = [];
  const started: string[] = [];

  return {
    async start() {
      const loaded = await readJobs(options.sql);
      jobs.length = 0;
      jobs.push(...loaded);

      for (const job of jobs) {
        const queue = pluginJobQueue(job.pluginId, job.name);

        if (job.schedule !== null) {
          await options.queue.schedule(queue, job.schedule, { payload: {} });
        }

        await options.queue.work(queue, async (batch) => {
          for (const item of batch) {
            const response = await request(`${options.hostUrl}/internal/jobs`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${options.token}`,
              },
              body: JSON.stringify({
                pluginId: job.pluginId,
                name: job.name,
                payload: item.data.payload,
              }),
            });

            if (!response.ok) {
              throw new Error(`Plugin job ${queue} failed with ${String(response.status)}`);
            }
          }
        });
        started.push(queue);
      }
    },

    async enqueue(job, payload) {
      await options.queue.send(
        pluginJobQueue(job.pluginId, job.name),
        { payload },
        {
          singletonKey: `plugin-job:${job.pluginId}:${job.name}`,
        },
      );
    },

    async stop() {
      for (const queue of started.splice(0)) {
        await options.queue.offWork(queue);
      }
    },
  };
}
