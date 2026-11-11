import type { Logger } from "@bulletin/config";
import {
  fetchUnfurl,
  isUnfurlFresh,
  listStaleUnfurls,
  readUnfurl,
  recordUnfurlResult,
  requestUnfurl,
  type UnfurlFetchResult,
} from "@bulletin/domain/content";
import type { SafeFetch } from "@bulletin/domain/net";
import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";
import { proxyUnfurlImage } from "./unfurl-images.ts";

export const UNFURL_QUEUE = "content.unfurl";
export const UNFURL_REFRESH_QUEUE = "content.unfurl.refresh";
/** Refresh cached cards after seven days (ADR 0007). */
export const UNFURL_REFRESH_CRON = "17 * * * *";

export interface UnfurlJobPayload {
  /** Jobs carry IDs only; the worker loads the URL from the cache row (ADR 0011). */
  readonly urlHash: string;
}

export interface UnfurlProcessOptions {
  readonly fetch?: SafeFetch;
  /** Fetcher for preview images; defaults to the SSRF-safe client (ADR 0016). */
  readonly imageFetch?: SafeFetch;
  /** When present, preview images are proxied and stored under `unfurl/<hash>`. */
  readonly storage?: StorageClient;
  readonly now?: Date;
}

export type UnfurlProcessResult =
  | { readonly kind: "cached" }
  | { readonly kind: "missing" }
  | { readonly kind: "stored"; readonly result: UnfurlFetchResult };

/** Processes one cached URL hash; the job payload never contains the URL itself. */
export async function processUnfurl(
  sql: SQL,
  urlHash: string,
  options: UnfurlProcessOptions = {},
): Promise<UnfurlProcessResult> {
  const now = options.now ?? new Date();
  const record = await readUnfurl(sql, urlHash);

  if (record === null) {
    return { kind: "missing" };
  }

  if (isUnfurlFresh(record, now) && record.preview !== null) {
    return { kind: "cached" };
  }

  const result = await fetchUnfurl(record.url, {
    now,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const stored =
    result.kind === "preview" && result.preview.imageUrl !== null && options.storage !== undefined
      ? await withProxiedImage(options.storage, result, options)
      : result;
  await recordUnfurlResult(sql, { urlHash, url: record.url, result: stored, now });

  return { kind: "stored", result: stored };
}

/** Attaches the local image path when the worker could proxy the third-party image. */
async function withProxiedImage(
  storage: StorageClient,
  result: Extract<UnfurlFetchResult, { readonly kind: "preview" }>,
  options: UnfurlProcessOptions,
): Promise<UnfurlFetchResult> {
  if (result.preview.imageUrl === null) {
    return result;
  }

  const proxy = await proxyUnfurlImage(storage, result.preview.imageUrl, {
    ...(options.imageFetch === undefined ? {} : { fetch: options.imageFetch }),
  });

  return proxy === null
    ? result
    : { kind: "preview", preview: { ...result.preview, imageProxy: proxy.path } };
}

export interface EnqueueUnfurlOptions {
  readonly now?: Date;
}

/** Registers a URL and sends one worker job when it is missing or stale. */
export async function enqueueUnfurl(
  boss: PgBoss,
  sql: SQL,
  url: string,
  options: EnqueueUnfurlOptions = {},
): Promise<string | null> {
  const request = await requestUnfurl(sql, url, options.now ?? new Date());

  if (request === null) {
    return null;
  }

  if (request.needed) {
    await boss.send(UNFURL_QUEUE, { urlHash: request.urlHash } satisfies UnfurlJobPayload, {
      singletonKey: `unfurl:${request.urlHash}`,
    });
  }

  return request.urlHash;
}

export interface UnfurlRefreshResult {
  readonly queued: number;
}

/** Finds pending and seven-day-old rows and enqueues one job per hash. */
export async function runUnfurlRefresh(
  sql: SQL,
  enqueue: (payload: UnfurlJobPayload) => Promise<void>,
  options: { readonly now?: Date; readonly limit?: number } = {},
): Promise<UnfurlRefreshResult> {
  const stale = await listStaleUnfurls(sql, options);
  let queued = 0;

  for (const record of stale) {
    await enqueue({ urlHash: record.urlHash });
    queued += 1;
  }

  return { queued };
}

export interface UnfurlJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
  readonly fetch?: SafeFetch;
  readonly imageFetch?: SafeFetch;
  readonly storage?: StorageClient;
  readonly now?: () => Date;
}

export interface UnfurlJobs {
  stop(): Promise<void>;
}

/** Registers the unfurl worker and its hourly refresh sweep (ADR 0007, 0011). */
export async function createUnfurlJobs(options: UnfurlJobsOptions): Promise<UnfurlJobs> {
  const now = options.now ?? (() => new Date());

  await ensurePgBossQueue(options.boss, UNFURL_QUEUE);
  await ensurePgBossQueue(options.boss, UNFURL_REFRESH_QUEUE);

  await options.boss.work<UnfurlJobPayload>(UNFURL_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        const result = await processUnfurl(options.sql, job.data.urlHash, {
          now: now(),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.imageFetch === undefined ? {} : { imageFetch: options.imageFetch }),
          ...(options.storage === undefined ? {} : { storage: options.storage }),
        });
        options.logger?.info("unfurl.processed", {
          urlHash: job.data.urlHash,
          result: result.kind,
        });
      } catch (error) {
        options.logger?.error("unfurl.failed", { urlHash: job.data.urlHash, error });
        throw error;
      }
    }
  });

  await options.boss.work(UNFURL_REFRESH_QUEUE, async () => {
    const result = await runUnfurlRefresh(
      options.sql,
      async (payload) => {
        await options.boss.send(UNFURL_QUEUE, payload, {
          singletonKey: `unfurl:${payload.urlHash}`,
        });
      },
      { now: now() },
    );
    options.logger?.info("unfurl.refresh.completed", { queued: result.queued });
  });

  await options.boss.schedule(UNFURL_REFRESH_QUEUE, UNFURL_REFRESH_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(UNFURL_QUEUE);
      await options.boss.offWork(UNFURL_REFRESH_QUEUE);
    },
  };
}
