import { bumpCacheTags, forumAnnouncementsTag, forumTag, GLOBAL_CACHE_TAGS } from "@bulletin/cache";
import type { Logger } from "@bulletin/config";
import type { ContentVersions, Emoticon, MentionResolver, ReplaceWords } from "@bulletin/content";
import { currentContentVersions, renderContent, renderSnapshot } from "@bulletin/content";
import {
  listStaleQuoteSnapshots,
  loadContentRenderDependencies,
  quoteSnapshotTags,
} from "@bulletin/domain/content";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

/** Re-render every stale content row in id order, resuming from a durable cursor (ADR 0007). */
export const CONTENT_RERENDER_QUEUE = "content.rerender";
export const CONTENT_RERENDER_CRON = "*/5 * * * *";
export const CONTENT_RERENDER_BATCH = 500;

export interface RerenderRow {
  readonly id: string;
  readonly bodyMd: string;
  readonly bodyHtml: string;
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
}

export interface RenderedContent {
  readonly bodyHtml: string;
  readonly bodyText?: string;
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
}

export interface ContentRenderOptions {
  readonly replaceWords?: ReplaceWords;
  readonly emoticons?: readonly Emoticon[];
  readonly mentions?: MentionResolver;
}

/**
 * Fills in the rendering dependencies the worker does not receive at startup. Tests and
 * callers that already hold them keep their explicit values.
 */
async function renderOptionsFor(
  sql: SQL,
  options: ContentRenderOptions,
): Promise<ContentRenderOptions> {
  if (options.emoticons !== undefined && options.mentions !== undefined) {
    return options;
  }

  const dependencies = await loadContentRenderDependencies(sql);

  return {
    ...(options.replaceWords === undefined ? {} : { replaceWords: options.replaceWords }),
    emoticons: options.emoticons ?? dependencies.emoticons,
    mentions: options.mentions ?? dependencies.mentions,
  };
}

/**
 * A table that stores rendered markdown. `topics-posts` adds the posts source; quote
 * snapshots are the source this change can already re-render.
 */
export interface ContentRerenderSource {
  readonly name: string;
  listStale(
    sql: SQL,
    versions: ContentVersions,
    options: { readonly afterId: string; readonly limit: number },
  ): Promise<readonly RerenderRow[]>;
  render(row: RerenderRow, options: ContentRenderOptions): Promise<RenderedContent>;
  /** Returns false when the source row changed while it was being rendered. */
  save(sql: SQL, row: RerenderRow, rendered: RenderedContent): Promise<boolean>;
}

/**
 * The rendering inputs every source shares. Quote snapshots, rules and announcements all go
 * through the same inline extensions, so they must receive the same current dependencies.
 */
function renderInputs(options: ContentRenderOptions) {
  return {
    ...(options.replaceWords === undefined ? {} : { replaceWords: options.replaceWords }),
    ...(options.emoticons === undefined ? {} : { emoticons: options.emoticons }),
    ...(options.mentions === undefined ? {} : { mentions: options.mentions }),
  };
}

export const quoteSnapshotRerenderSource: ContentRerenderSource = {
  name: "quote_snapshots",
  listStale: (sql, versions, options) =>
    listStaleQuoteSnapshots(sql, versions, {
      afterId: options.afterId,
      limit: options.limit,
    }),
  async render(row, options) {
    const rendered = await renderSnapshot(row.bodyMd, {
      profile: "post",
      context: { kind: "forum_post", forumId: "1" },
      authorId: "0",
      ...renderInputs(options),
    });

    return {
      bodyHtml: rendered.bodyHtml,
      renderVersion: rendered.renderVersion,
      sanitiserVersion: rendered.sanitiserVersion,
    };
  },
  async save(sql, row, value) {
    return sql.begin(async (tx) => {
      const rows = (await tx`
        UPDATE core.quote_snapshots
        SET body_html = ${value.bodyHtml},
          render_version = ${value.renderVersion},
          sanitiser_version = ${value.sanitiserVersion}
        WHERE id = ${row.id}
          AND body_md = ${row.bodyMd}
          AND render_version = ${row.renderVersion}
          AND sanitiser_version = ${row.sanitiserVersion}
        RETURNING source_kind, source_id::text AS source_id
      `) as Array<{ source_kind: string; source_id: string }>;

      const source = rows[0];

      if (
        source !== undefined &&
        (source.source_kind === "post" || source.source_kind === "message")
      ) {
        const tags = quoteSnapshotTags({ kind: source.source_kind, id: source.source_id });

        if (tags.length > 0) {
          await bumpCacheTags(tx, tags);
        }
      }

      return rows.length > 0;
    });
  },
};

interface RuleRow {
  readonly id: string;
  readonly rules: string;
  readonly rules_html: string;
  readonly rules_text: string;
  readonly rules_render_version: number;
  readonly rules_sanitiser_version: number;
}

interface AnnouncementRow {
  readonly id: string;
  readonly body: string;
  readonly body_html: string;
  readonly body_text: string;
  readonly render_version: number;
  readonly sanitiser_version: number;
}

function rendered(result: {
  readonly bodyHtml: string;
  readonly bodyText?: string;
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
}): RenderedContent {
  return {
    bodyHtml: result.bodyHtml,
    ...(result.bodyText === undefined ? {} : { bodyText: result.bodyText }),
    renderVersion: result.renderVersion,
    sanitiserVersion: result.sanitiserVersion,
  };
}

export const forumRulesRerenderSource: ContentRerenderSource = {
  name: "forum_rules",
  async listStale(sql, versions, options) {
    const rows = (await sql`
      SELECT id::text AS id, rules, rules_html, rules_text,
        rules_render_version, rules_sanitiser_version
      FROM core.forums
      WHERE id > ${options.afterId}
        AND (
          rules_render_version <> ${versions.renderVersion}
          OR rules_sanitiser_version <> ${versions.sanitiserVersion}
          OR (rules <> '' AND rules_html = '')
        )
      ORDER BY id
      LIMIT ${options.limit}
    `) as RuleRow[];

    return rows.map((row) => ({
      id: row.id,
      bodyMd: row.rules,
      bodyHtml: row.rules_html,
      renderVersion: row.rules_render_version,
      sanitiserVersion: row.rules_sanitiser_version,
    }));
  },
  async render(row, options) {
    return rendered(
      await renderContent(row.bodyMd, {
        profile: "rules",
        context: { kind: "forum_post", forumId: "1" },
        authorId: "0",
        ...renderInputs(options),
      }),
    );
  },
  async save(sql, row, value) {
    return sql.begin(async (tx) => {
      const rows = (await tx`
        UPDATE core.forums
        SET rules_html = ${value.bodyHtml},
          rules_text = ${value.bodyText ?? ""},
          rules_render_version = ${value.renderVersion},
          rules_sanitiser_version = ${value.sanitiserVersion}
        WHERE id = ${row.id}
          AND rules = ${row.bodyMd}
          AND rules_render_version = ${row.renderVersion}
          AND rules_sanitiser_version = ${row.sanitiserVersion}
        RETURNING id
      `) as Array<{ id: string }>;

      if (rows.length > 0) {
        await bumpCacheTags(tx, [forumTag(row.id)]);
      }

      return rows.length > 0;
    });
  },
};

export const announcementRerenderSource: ContentRerenderSource = {
  name: "announcements",
  async listStale(sql, versions, options) {
    const rows = (await sql`
      SELECT id::text AS id, body, body_html, body_text, render_version, sanitiser_version
      FROM core.announcements
      WHERE id > ${options.afterId}
        AND (
          render_version <> ${versions.renderVersion}
          OR sanitiser_version <> ${versions.sanitiserVersion}
          OR (body <> '' AND body_html = '')
        )
      ORDER BY id
      LIMIT ${options.limit}
    `) as AnnouncementRow[];

    return rows.map((row) => ({
      id: row.id,
      bodyMd: row.body,
      bodyHtml: row.body_html,
      renderVersion: row.render_version,
      sanitiserVersion: row.sanitiser_version,
    }));
  },
  async render(row, options) {
    return rendered(
      await renderContent(row.bodyMd, {
        profile: "rules",
        context: { kind: "forum_post", forumId: "1" },
        authorId: "0",
        ...renderInputs(options),
      }),
    );
  },
  async save(sql, row, value) {
    return sql.begin(async (tx) => {
      const rows = (await tx`
        UPDATE core.announcements
        SET body_html = ${value.bodyHtml},
          body_text = ${value.bodyText ?? ""},
          render_version = ${value.renderVersion},
          sanitiser_version = ${value.sanitiserVersion}
        WHERE id = ${row.id}
          AND body = ${row.bodyMd}
          AND render_version = ${row.renderVersion}
          AND sanitiser_version = ${row.sanitiserVersion}
        RETURNING id, scope
      `) as Array<{ id: string; scope: string }>;

      if (rows.length > 0) {
        const forums = (await tx`
          SELECT DISTINCT f.id::text AS id
          FROM core.announcement_targets t
          JOIN core.forums target ON target.id = t.forum_id
          JOIN core.forums f
            ON f.id = t.forum_id OR (t.include_subforums AND f.path <@ target.path)
          WHERE t.announcement_id = ${row.id}
        `) as Array<{ id: string }>;
        const tags = [
          ...(rows[0]?.scope === "global" ? [GLOBAL_CACHE_TAGS.announcements] : []),
          ...forums.map((forum) => forumAnnouncementsTag(forum.id)),
        ];

        if (tags.length > 0) {
          await bumpCacheTags(tx, tags);
        }
      }

      return rows.length > 0;
    });
  },
};

/** Every core content table the worker keeps current. */
export function contentRerenderSources(): readonly ContentRerenderSource[] {
  return [quoteSnapshotRerenderSource, forumRulesRerenderSource, announcementRerenderSource];
}

export interface ContentRerenderOptions extends ContentRenderOptions {
  readonly source?: ContentRerenderSource;
  readonly sources?: readonly ContentRerenderSource[];
  readonly versions?: ContentVersions;
  readonly batchSize?: number;
  /** Time-box a run; the cursor lets the next run continue where this one stopped. */
  readonly maxBatches?: number;
}

export interface ContentRerenderResult {
  readonly rerendered: number;
  readonly batches: number;
  readonly cursorKey: string;
  readonly lastId: string;
}

/** A campaign is identified by its versions, so a new bump starts a fresh cursor. */
export function rerenderCursorKey(sourceName: string, versions: ContentVersions): string {
  return `content.render:${sourceName}:${versions.renderVersion}:${versions.sanitiserVersion}`;
}

/**
 * `core.job_cursors.last_event_id` is the table's durable cursor column; content jobs use it
 * for the last processed row id, keyed by source and versions.
 */
async function readCursor(sql: SQL, key: string): Promise<string> {
  const rows = (await sql`
    SELECT last_event_id::text AS last_event_id
    FROM core.job_cursors
    WHERE subscriber = ${key}
  `) as Array<{ last_event_id: string }>;

  return rows[0]?.last_event_id ?? "0";
}

async function writeCursor(sql: SQL, key: string, lastId: string): Promise<void> {
  await sql`
    INSERT INTO core.job_cursors (subscriber, last_event_id, updated_at)
    VALUES (${key}, ${lastId}, now())
    ON CONFLICT (subscriber) DO UPDATE
      SET last_event_id = GREATEST(core.job_cursors.last_event_id, EXCLUDED.last_event_id),
        updated_at = now()
  `;
}

/**
 * Batches of stale rows ordered by id. Each batch writes the cursor after its updates, so a
 * crash between batches re-runs at most one batch and a new version starts at id 0.
 */
export async function runContentRerenderJob(
  sql: SQL,
  options: ContentRerenderOptions = {},
): Promise<ContentRerenderResult> {
  const sources =
    options.sources ??
    (options.source === undefined ? [quoteSnapshotRerenderSource] : [options.source]);
  const versions = options.versions ?? currentContentVersions(options.replaceWords);
  const batchSize = options.batchSize ?? CONTENT_RERENDER_BATCH;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  let rerendered = 0;
  let batches = 0;
  let lastId = "0";
  const cursorKeys: string[] = [];
  let resolvedRenderOptions: ContentRenderOptions | null = null;

  async function renderOptions(): Promise<ContentRenderOptions> {
    resolvedRenderOptions ??= await renderOptionsFor(sql, options);
    return resolvedRenderOptions;
  }

  for (const source of sources) {
    const cursorKey = rerenderCursorKey(source.name, versions);
    cursorKeys.push(cursorKey);
    let cursor = await readCursor(sql, cursorKey);
    let sourceBatches = 0;

    while (sourceBatches < maxBatches) {
      const rows = await source.listStale(sql, versions, { afterId: cursor, limit: batchSize });

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        // The row id advances only after its write, so the cursor never skips a failure.
        const value = await source.render(row, await renderOptions());
        const saved = await source.save(sql, row, value);
        cursor = row.id;

        if (saved) {
          rerendered += 1;
        }
      }

      await writeCursor(sql, cursorKey, cursor);
      sourceBatches += 1;
      batches += 1;

      if (rows.length < batchSize) {
        break;
      }
    }

    lastId = cursor;
  }

  return { rerendered, batches, cursorKey: cursorKeys.join("|"), lastId };
}

export interface ContentJobsOptions extends ContentRerenderOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
}

export interface ContentJobs {
  stop(): Promise<void>;
}

/** Sends an immediate re-render after a version bump; the periodic sweep is the safety net. */
export async function enqueueContentRerender(boss: PgBoss): Promise<void> {
  await boss.send(CONTENT_RERENDER_QUEUE, {}, { singletonKey: "content.rerender" });
}

/** Registers the re-render queue and its periodic stale-content sweep. */
export async function createContentJobs(options: ContentJobsOptions): Promise<ContentJobs> {
  await ensurePgBossQueue(options.boss, CONTENT_RERENDER_QUEUE);

  await options.boss.work(CONTENT_RERENDER_QUEUE, async () => {
    const result = await runContentRerenderJob(options.sql, {
      ...options,
      sources: options.sources ?? contentRerenderSources(),
    });
    options.logger?.info("content.rerender.completed", {
      rerendered: result.rerendered,
      batches: result.batches,
      cursorKey: result.cursorKey,
    });
  });

  await options.boss.schedule(CONTENT_RERENDER_QUEUE, CONTENT_RERENDER_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(CONTENT_RERENDER_QUEUE);
    },
  };
}
