import {
  bumpCacheTags,
  forumAnnouncementsTag,
  forumTag,
  GLOBAL_CACHE_TAGS,
  memberTag,
  postTag,
  topicPagesTag,
  topicTag,
} from "@bulletin/cache";
import type { Logger } from "@bulletin/config";
import type {
  ContentVersions,
  EmbedProvider,
  Emoticon,
  MentionResolver,
  ReplaceWords,
} from "@bulletin/content";
import {
  ContentError,
  currentContentVersions,
  refreshStoredHtml,
  renderContent,
  renderSnapshot,
} from "@bulletin/content";
import {
  listStaleQuoteSnapshots,
  loadContentRenderDependencies,
  quoteSnapshotTags,
} from "@bulletin/domain/content";
import { FILTER_RERENDER_CHANNEL, loadReplaceWords } from "@bulletin/domain/filters";
import { loadForumTree } from "@bulletin/domain/permissions";
import { createPostQuotePipeline } from "@bulletin/domain/topics";
import { evaluateFlag, GUEST_VIEWER } from "@bulletin/flags";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";
import { loadStoredFlags } from "../flags/index.ts";

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
  /** Conversation sources only: the context and author needed for a Markdown re-render. */
  readonly conversationId?: string;
  /** Forum sources only: the topic and forum the post belongs to. */
  readonly topicId?: string;
  readonly forumId?: string;
  readonly authorId?: string;
}

export interface RenderedContent {
  readonly bodyHtml: string;
  readonly bodyText?: string;
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
  readonly quotedForumIds?: readonly string[];
  readonly mentionedMemberIds?: readonly string[];
  readonly quotedPostIds?: readonly string[];
}

export interface ContentRenderOptions {
  readonly replaceWords?: ReplaceWords;
  readonly emoticons?: readonly Emoticon[];
  readonly mentions?: MentionResolver;
  readonly embeds?: readonly EmbedProvider[];
}

/**
 * Background re-renders have no author, so flag-gated extensions follow the flag's site-wide
 * value (the guest evaluation). Partial rollouts therefore fail closed: a re-render never
 * turns `@name` into a profile link unless mentions are on for everyone (ADR 0010).
 */
async function siteWideFlag(sql: SQL, key: string): Promise<boolean> {
  const definition = (await loadStoredFlags(sql)).find((flag) => flag.key === key);

  return definition !== undefined && evaluateFlag(definition, GUEST_VIEWER);
}

/**
 * Fills in the rendering dependencies the worker does not receive at startup. Tests and
 * callers that already hold them keep their explicit values.
 */
async function renderOptionsFor(
  sql: SQL,
  options: ContentRenderOptions,
): Promise<ContentRenderOptions> {
  if (
    options.emoticons !== undefined &&
    options.mentions !== undefined &&
    options.embeds !== undefined
  ) {
    return options;
  }

  const [dependencies, mentionsEnabled, replaceWords] = await Promise.all([
    loadContentRenderDependencies(sql),
    siteWideFlag(sql, "mentions"),
    options.replaceWords === undefined ? loadReplaceWords(sql) : options.replaceWords,
  ]);
  const mentions = options.mentions ?? (mentionsEnabled ? dependencies.mentions : undefined);

  return {
    replaceWords,
    emoticons: options.emoticons ?? dependencies.emoticons,
    ...(mentions === undefined ? {} : { mentions }),
    embeds: options.embeds ?? dependencies.embeds,
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
  render(sql: SQL, row: RerenderRow, options: ContentRenderOptions): Promise<RenderedContent>;
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
    ...(options.embeds === undefined ? {} : { embeds: options.embeds }),
  };
}

export const quoteSnapshotRerenderSource: ContentRerenderSource = {
  name: "quote_snapshots",
  listStale: (sql, versions, options) =>
    listStaleQuoteSnapshots(sql, versions, {
      afterId: options.afterId,
      limit: options.limit,
    }),
  async render(_sql, row, options) {
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
  async render(_sql, row, options) {
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
  async render(_sql, row, options) {
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
interface ConversationMessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly author_id: string;
  readonly body_md: string;
  readonly body_html: string;
  readonly body_text: string;
  readonly render_version: number;
  readonly sanitiser_version: number;
}

/** Personal messages still need the current sanitiser before a live or cached read (ADR 0007). */
export const conversationMessageRerenderSource: ContentRerenderSource = {
  name: "conversation_messages",
  async listStale(sql, versions, options) {
    const rows = (await sql`
      SELECT id::text AS id, conversation_id::text AS conversation_id,
        author_id::text AS author_id, body_md, body_html, body_text,
        render_version, sanitiser_version
      FROM core.conversation_messages
      WHERE id > ${options.afterId}
        AND (
          render_version <> ${versions.renderVersion}
          OR sanitiser_version <> ${versions.sanitiserVersion}
        )
      ORDER BY id
      LIMIT ${options.limit}
    `) as ConversationMessageRow[];

    return rows.map((row) => ({
      id: row.id,
      bodyMd: row.body_md,
      bodyHtml: row.body_html,
      renderVersion: row.render_version,
      sanitiserVersion: row.sanitiser_version,
      conversationId: row.conversation_id,
      authorId: row.author_id,
    }));
  },
  async render(sql, row, options) {
    const versions = currentContentVersions(options.replaceWords);
    const quotePipeline = {
      resolver: {
        async canRead(ref: { readonly kind: string; readonly id: string }): Promise<boolean> {
          if (ref.kind !== "message" || row.conversationId === undefined) {
            return false;
          }

          const found = (await sql`
            SELECT 1
            FROM core.conversation_messages source
            JOIN core.quote_snapshots snapshot
              ON snapshot.source_kind = 'message' AND snapshot.source_id = source.id
            WHERE source.id = ${ref.id}
              AND source.conversation_id = ${row.conversationId}
            LIMIT 1
          `) as unknown[];

          return found.length > 0;
        },
        async load(ref: { readonly kind: string; readonly id: string }) {
          if (ref.kind !== "message" || row.conversationId === undefined) {
            return null;
          }

          const [source] = (await sql`
            SELECT id::text AS id, author_id::text AS author_id, body_md,
              conversation_id::text AS conversation_id
            FROM core.conversation_messages
            WHERE id = ${ref.id} AND conversation_id = ${row.conversationId}
          `) as Array<{
            id: string;
            author_id: string;
            body_md: string;
            conversation_id: string;
          }>;

          return source === undefined
            ? null
            : {
                ref: { kind: "message" as const, id: source.id },
                sourceAuthorId: source.author_id,
                bodyMd: source.body_md,
                contextId: source.conversation_id,
              };
        },
      },
      snapshots: {
        async create(draft: { readonly sourceKind: string; readonly sourceId: string }) {
          const [existing] = (await sql`
            SELECT id::text AS id
            FROM core.quote_snapshots
            WHERE source_kind = ${draft.sourceKind} AND source_id = ${draft.sourceId}
            ORDER BY id
            LIMIT 1
          `) as Array<{ id: string }>;

          if (existing === undefined) {
            throw new Error("A quote snapshot disappeared during re-render");
          }

          return existing.id;
        },
      },
    };

    try {
      const rendered = await renderContent(row.bodyMd, {
        profile: "post",
        context: {
          kind: "conversation_message",
          conversationId: row.conversationId ?? "0",
        },
        authorId: row.authorId ?? "0",
        ...renderInputs(options),
        quotes: quotePipeline as never,
      });

      return {
        bodyHtml: rendered.bodyHtml,
        bodyText: rendered.bodyText,
        renderVersion: rendered.renderVersion,
        sanitiserVersion: rendered.sanitiserVersion,
      };
    } catch (error) {
      if (!(error instanceof ContentError)) {
        throw error;
      }

      // A quoted source that was removed while a held message survived keeps its stored
      // placeholder HTML; a refresh still applies the current sanitiser (ADR 0007).
      const refreshed = await refreshStoredHtml(row.bodyHtml, {
        profile: "post",
        ...(options.replaceWords === undefined ? {} : { replaceWords: options.replaceWords }),
        ...(options.embeds === undefined ? {} : { embedProviders: options.embeds }),
      });

      return {
        bodyHtml: refreshed.bodyHtml,
        bodyText: refreshed.bodyText,
        renderVersion: versions.renderVersion,
        sanitiserVersion: versions.sanitiserVersion,
      };
    }
  },
  async save(sql, row, value) {
    const rows = (await sql`
      UPDATE core.conversation_messages
      SET body_html = ${value.bodyHtml},
        body_text = ${value.bodyText ?? ""},
        render_version = ${value.renderVersion},
        sanitiser_version = ${value.sanitiserVersion}
      WHERE id = ${row.id}
        AND body_html = ${row.bodyHtml}
        AND render_version = ${row.renderVersion}
        AND sanitiser_version = ${row.sanitiserVersion}
      RETURNING id
    `) as Array<{ id: string }>;

    return rows.length > 0;
  },
};

/** Forum posts, rebuilt from Markdown after replace-word or sanitiser changes (ADR 0007). */
export const postRerenderSource: ContentRerenderSource = {
  name: "posts",
  async listStale(sql, versions, options) {
    const rows = (await sql`
      SELECT p.id::text AS id, p.topic_id::text AS topic_id, t.forum_id::text AS forum_id,
        p.author_id::text AS author_id, p.body_md, p.body_html, p.body_text,
        p.render_version, p.sanitiser_version
      FROM core.posts p
      JOIN core.topics t ON t.id = p.topic_id
      WHERE p.id > ${options.afterId}
        AND (
          p.render_version <> ${versions.renderVersion}
          OR p.sanitiser_version <> ${versions.sanitiserVersion}
        )
      ORDER BY p.id
      LIMIT ${options.limit}
    `) as Array<{
      id: string;
      topic_id: string;
      forum_id: string;
      author_id: string | null;
      body_md: string;
      body_html: string;
      body_text: string;
      render_version: number;
      sanitiser_version: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      bodyMd: row.body_md,
      bodyHtml: row.body_html,
      renderVersion: row.render_version,
      sanitiserVersion: row.sanitiser_version,
      topicId: row.topic_id,
      forumId: row.forum_id,
      ...(row.author_id === null ? {} : { authorId: row.author_id }),
    }));
  },
  async render(sql, row, options) {
    const tree = await loadForumTree(sql);
    const renderedPost = await renderContent(row.bodyMd, {
      profile: "post",
      context: { kind: "forum_post", forumId: row.forumId ?? "0" },
      authorId: row.authorId ?? "0",
      ...renderInputs(options),
      quotes: createPostQuotePipeline(sql, tree),
    });

    return {
      bodyHtml: renderedPost.bodyHtml,
      bodyText: renderedPost.bodyText,
      renderVersion: renderedPost.renderVersion,
      sanitiserVersion: renderedPost.sanitiserVersion,
      quotedForumIds: renderedPost.quotedForumIds,
      mentionedMemberIds: renderedPost.mentionedMemberIds,
      quotedPostIds: renderedPost.quoteSources
        .filter((source) => source.kind === "post")
        .map((source) => source.id),
    };
  },
  async save(sql, row, value) {
    const quotedForumIds = value.quotedForumIds ?? [];
    const mentionedMemberIds = value.mentionedMemberIds ?? [];
    const quotedPostIds = value.quotedPostIds ?? [];

    return sql.begin(async (tx) => {
      const rows = (await tx`
        UPDATE core.posts
        SET body_html = ${value.bodyHtml},
          body_text = ${value.bodyText ?? ""},
          render_version = ${value.renderVersion},
          sanitiser_version = ${value.sanitiserVersion},
          quoted_forum_ids = ${`{${quotedForumIds.join(",")}}`}::bigint[],
          mentioned_member_ids = ${`{${mentionedMemberIds.join(",")}}`}::bigint[],
          quoted_post_ids = ${`{${quotedPostIds.join(",")}}`}::bigint[]
        WHERE id = ${row.id}
          AND body_md = ${row.bodyMd}
          AND render_version = ${row.renderVersion}
          AND sanitiser_version = ${row.sanitiserVersion}
        RETURNING topic_id::text AS topic_id, author_id::text AS author_id
      `) as Array<{
        topic_id: string;
        author_id: string | null;
      }>;
      const saved = rows[0];

      if (saved === undefined) {
        return false;
      }

      await bumpCacheTags(tx, [
        postTag(row.id),
        topicTag(saved.topic_id),
        topicPagesTag(saved.topic_id),
        ...(row.forumId === undefined ? [] : [forumTag(row.forumId)]),
        ...(saved.author_id === null ? [] : [memberTag(saved.author_id)]),
      ]);

      return true;
    });
  },
};

export function contentRerenderSources(): readonly ContentRerenderSource[] {
  return [
    quoteSnapshotRerenderSource,
    forumRulesRerenderSource,
    announcementRerenderSource,
    postRerenderSource,
    conversationMessageRerenderSource,
  ];
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
  const replaceWords = options.replaceWords ?? (await loadReplaceWords(sql));
  const versions = options.versions ?? currentContentVersions(replaceWords);
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
        const value = await source.render(sql, row, await renderOptions());
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

  // A filter edit wakes the worker immediately; the cron above remains the recovery path.
  const listener = await options.sql.listen(FILTER_RERENDER_CHANNEL, () => {
    void enqueueContentRerender(options.boss).catch((error: unknown) => {
      options.logger?.error("content.rerender_wake_failed", { error });
    });
  });

  return {
    async stop() {
      await listener.unlisten();
      await options.boss.offWork(CONTENT_RERENDER_QUEUE);
    },
  };
}
