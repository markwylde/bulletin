import type { Logger } from "@bulletin/config";
import { FORUM_LANGUAGE_CHANNEL } from "@bulletin/domain/search";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

/** Rebuilds one forum's `lang` columns after its language setting changes (ADR 0017). */
export const SEARCH_LANGUAGE_QUEUE = "search.language";
export const SEARCH_LANGUAGE_SWEEP_QUEUE = "search.language.sweep";
export const SEARCH_LANGUAGE_SWEEP_CRON = "*/5 * * * *";
export const LANGUAGE_REBUILD_BATCH = 1_000;

export interface ForumLanguageJobPayload {
  readonly forumId: string;
  /** The forum's `search_lang_version` the job was queued for. */
  readonly version: string;
}

export interface LanguageRebuildResult {
  readonly topics: number;
  readonly posts: number;
  readonly batches: number;
}

export interface LanguageRebuildOptions {
  readonly batchSize?: number;
}

interface ForumVersionRow {
  readonly version: string;
}

interface IdRow {
  readonly id: string;
}

async function runBatches(
  batch: () => Promise<readonly IdRow[]>,
  batchSize: number,
): Promise<{ readonly rows: number; readonly batches: number }> {
  let rows = 0;
  let batches = 0;

  for (;;) {
    const updated = await batch();

    if (updated.length === 0) {
      break;
    }

    rows += updated.length;
    batches += 1;

    if (updated.length < batchSize) {
      break;
    }
  }

  return { rows, batches };
}

/**
 * Re-indexes a forum's topics and posts in batches, then records how far the index caught up.
 *
 * The loop compares the stored `lang` with the forum's current language, so rerunning a
 * completed job is a no-op. The indexed version only advances to the version the job was
 * queued for: a language change during the rebuild stays pending for the next sweep.
 */
export async function rebuildForumLanguage(
  sql: SQL,
  forumId: string,
  options: LanguageRebuildOptions = {},
): Promise<LanguageRebuildResult> {
  const batchSize = options.batchSize ?? LANGUAGE_REBUILD_BATCH;
  const [forum] = (await sql`
    SELECT search_lang_version::text AS version
    FROM core.forums
    WHERE id = ${forumId}
  `) as ForumVersionRow[];

  if (forum === undefined) {
    return { topics: 0, posts: 0, batches: 0 };
  }

  const topics = await runBatches(async () => {
    return (await sql`
      WITH batch AS (
        SELECT topic.id
        FROM core.topics AS topic
        JOIN core.forums AS forum ON forum.id = topic.forum_id
        WHERE topic.forum_id = ${forumId}
          AND topic.lang IS DISTINCT FROM core.search_config(forum.language)
        ORDER BY topic.id
        LIMIT ${batchSize}
      )
      UPDATE core.topics AS topic
      SET lang = core.search_config(forum.language)
      FROM core.forums AS forum, batch
      WHERE topic.id = batch.id
        AND forum.id = topic.forum_id
      RETURNING topic.id::text AS id
    `) as IdRow[];
  }, batchSize);

  const posts = await runBatches(async () => {
    return (await sql`
      WITH batch AS (
        SELECT post.id
        FROM core.posts AS post
        JOIN core.topics AS topic ON topic.id = post.topic_id
        JOIN core.forums AS forum ON forum.id = topic.forum_id
        WHERE topic.forum_id = ${forumId}
          AND post.lang IS DISTINCT FROM core.search_config(forum.language)
        ORDER BY post.id
        LIMIT ${batchSize}
      )
      UPDATE core.posts AS post
      SET lang = core.search_config(forum.language)
      FROM core.topics AS topic, core.forums AS forum, batch
      WHERE post.id = batch.id
        AND topic.id = post.topic_id
        AND forum.id = topic.forum_id
      RETURNING post.id::text AS id
    `) as IdRow[];
  }, batchSize);

  await sql`
    UPDATE core.forums
    SET search_lang_indexed_version = GREATEST(search_lang_indexed_version, ${forum.version}::bigint)
    WHERE id = ${forumId}
  `;

  return { topics: topics.rows, posts: posts.rows, batches: topics.batches + posts.batches };
}

export interface ForumLanguageRebuildQueueRow {
  readonly forumId: string;
  readonly version: string;
}

/** Forums whose language changed after the last completed rebuild; the sweep's work list. */
export async function listForumsNeedingLanguageRebuild(
  sql: SQL,
  limit = 50,
): Promise<readonly ForumLanguageRebuildQueueRow[]> {
  return (await sql`
    SELECT id::text AS "forumId", search_lang_version::text AS version
    FROM core.forums
    WHERE search_lang_version > search_lang_indexed_version
    ORDER BY id
    LIMIT ${limit}
  `) as ForumLanguageRebuildQueueRow[];
}

export interface SearchJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  /**
   * The direct connection for LISTEN (ADR 0003); defaults to `sql`. Must not be a
   * transaction-mode pooler, which drops LISTEN state between transactions.
   */
  readonly listenSql?: SQL;
  readonly logger?: Logger;
}

export interface SearchJobs {
  stop(): Promise<void>;
}

async function enqueueLanguageRebuild(
  options: SearchJobsOptions,
  row: ForumLanguageRebuildQueueRow,
): Promise<void> {
  await options.boss.send(
    SEARCH_LANGUAGE_QUEUE,
    { forumId: row.forumId, version: row.version } satisfies ForumLanguageJobPayload,
    { singletonKey: `${SEARCH_LANGUAGE_QUEUE}:${row.forumId}:${row.version}` },
  );
}

/** Registers the forum-language rebuild queue, its wake-up listener and its recovery sweep. */
export async function createSearchJobs(options: SearchJobsOptions): Promise<SearchJobs> {
  await ensurePgBossQueue(options.boss, SEARCH_LANGUAGE_QUEUE);
  await ensurePgBossQueue(options.boss, SEARCH_LANGUAGE_SWEEP_QUEUE);

  await options.boss.work<ForumLanguageJobPayload>(SEARCH_LANGUAGE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        const result = await rebuildForumLanguage(options.sql, job.data.forumId);
        options.logger?.info("search.language.rebuilt", {
          forumId: job.data.forumId,
          version: job.data.version,
          ...result,
        });
      } catch (error) {
        options.logger?.error("search.language.rebuild_failed", {
          forumId: job.data.forumId,
          error,
        });
        throw error;
      }
    }
  });

  await options.boss.work(SEARCH_LANGUAGE_SWEEP_QUEUE, async () => {
    const forums = await listForumsNeedingLanguageRebuild(options.sql);

    for (const forum of forums) {
      await enqueueLanguageRebuild(options, forum);
    }

    options.logger?.info("search.language.swept", { forums: forums.length });
  });

  await options.boss.schedule(SEARCH_LANGUAGE_SWEEP_QUEUE, SEARCH_LANGUAGE_SWEEP_CRON, {});

  // The staff app wakes the worker immediately; the five-minute sweep is the recovery path.
  const listener = await (options.listenSql ?? options.sql).listen(
    FORUM_LANGUAGE_CHANNEL,
    (forumId) => {
      void (async () => {
        const [row] = (await options.sql`
        SELECT id::text AS "forumId", search_lang_version::text AS version
        FROM core.forums
        WHERE id = ${forumId}
      `) as ForumLanguageRebuildQueueRow[];

        if (row !== undefined) {
          await enqueueLanguageRebuild(options, row);
        }
      })().catch((error: unknown) => {
        options.logger?.error("search.language.wake_failed", { forumId, error });
      });
    },
  );

  return {
    async stop() {
      await listener.unlisten();
      await options.boss.offWork(SEARCH_LANGUAGE_QUEUE);
      await options.boss.offWork(SEARCH_LANGUAGE_SWEEP_QUEUE);
    },
  };
}
