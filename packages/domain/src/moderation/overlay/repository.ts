import {
  ensureCurrentRendering,
  replaceWordsInText,
  resolveQuotePlaceholders,
} from "@bulletin/content";
import type { Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import { listEmbedProviders } from "../../content/embeds.ts";
import { loadQuoteSnapshot } from "../../content/quotes.ts";
import { loadReplaceWords } from "../../filters/repository.ts";
import { can } from "../../permissions/can.ts";
import { loadPermissionSnapshot, type PermissionSnapshot } from "../../permissions/snapshot.ts";
import type { ForumTree } from "../../permissions/tree.ts";
import { loadForumTree } from "../../permissions/tree-store.ts";
import { loadQuoteSources } from "../../topics/reading/repository.ts";
import { canonicalUrl } from "../../urls/index.ts";

export interface OverlayHeldPost {
  readonly postId: string;
  readonly topicId: string;
  readonly position: number;
  readonly authorName: string;
  readonly bodyHtml: string;
  readonly createdAt: string;
  readonly href: string;
}

export interface OverlayHeldTopic {
  readonly topicId: string;
  readonly title: string;
  readonly href: string;
  readonly createdAt: string;
  readonly reason: string | null;
}

const OVERLAY_HELD_LIMIT = 50;

function quoteSourceIds(html: string): readonly string[] {
  const ids: string[] = [];

  for (const match of html.matchAll(/<bl-quote\b[^>]*data-source="(\d+)"/g)) {
    if (match[1] !== undefined) {
      ids.push(match[1]);
    }
  }

  return ids;
}

async function resolveHeldBodies(
  sql: SQL,
  rows: readonly {
    readonly postId: string;
    readonly bodyHtml: string;
    readonly bodyHtmlUnfiltered: string | null;
    readonly bodyText: string;
    readonly renderVersion: number;
    readonly sanitiserVersion: number;
  }[],
  viewerId: string,
  tree: ForumTree,
  snapshot: PermissionSnapshot,
  sessionId: string | null,
  embedProviders: Awaited<ReturnType<typeof listEmbedProviders>>,
  translate: Translator,
  replaceWords: Awaited<ReturnType<typeof loadReplaceWords>>,
): Promise<ReadonlyMap<string, string>> {
  const rendered = new Map<string, string>();
  const sources = new Map(
    await loadQuoteSources(
      sql,
      rows.flatMap((row) => quoteSourceIds(row.bodyHtml)),
    ),
  );
  const resolver = {
    async loadSnapshot(snapshotId: string) {
      return loadQuoteSnapshot(sql, snapshotId);
    },
    async canRead(ref: { readonly kind: string; readonly id: string }): Promise<boolean> {
      if (ref.kind !== "post") {
        return false;
      }

      const source = sources.get(ref.id);

      if (source === undefined || source.visibility === "soft_deleted") {
        return false;
      }

      if (
        source.visibility === "unapproved" &&
        source.authorId !== viewerId &&
        !(await can(sql, viewerId, "see_unapproved", {
          forumId: source.forumId,
          tree,
          snapshot,
          sessionId,
        }))
      ) {
        return false;
      }

      return can(sql, viewerId, "read", {
        forumId: source.forumId,
        tree,
        snapshot,
        sessionId,
      });
    },
    sourceUrl(ref: { readonly kind: string; readonly id: string }): string | null {
      const source = sources.get(ref.id);

      return source === undefined
        ? null
        : canonicalUrl("topic", source.topicId, source.topicSlug, { postId: source.postId });
    },
  };

  for (const row of rows) {
    const unfilteredSource = row.bodyHtmlUnfiltered !== null;
    const current = await ensureCurrentRendering(
      {
        bodyHtml: row.bodyHtmlUnfiltered ?? row.bodyHtml,
        bodyText: row.bodyText,
        renderVersion: row.renderVersion,
        sanitiserVersion: row.sanitiserVersion,
      },
      {
        profile: "post",
        embedProviders,
        mentions: false,
        replaceWords,
        // The unfiltered source always needs the current replacement list; the stored
        // filtered HTML only needs it when its render versions are stale.
        ...(unfilteredSource ? { versions: { renderVersion: -1, sanitiserVersion: -1 } } : {}),
      },
    );
    rendered.set(
      row.postId,
      await resolveQuotePlaceholders(current.bodyHtml, {
        resolver,
        viewerId,
        translate,
      }),
    );
  }

  return rendered;
}

interface HeldPostRow {
  readonly post_id: string;
  readonly topic_id: string;
  readonly topic_slug: string;
  readonly forum_id: string;
  readonly position: number;
  readonly body_html: string;
  readonly body_html_unfiltered: string | null;
  readonly body_text: string;
  readonly render_version: number;
  readonly sanitiser_version: number;
  readonly created_at: Date;
  readonly author_name: string | null;
}

/**
 * The viewer's own held posts for one topic page. Moderators already receive held rows in
 * the shared fragment, so the overlay adds nothing for them (ADR 0005/0006).
 */
export async function heldPostsForOverlay(
  sql: SQL,
  input: {
    readonly memberId: string;
    readonly topicId: string;
    readonly translate: Translator;
    readonly sessionId: string | null;
    readonly tree?: ForumTree;
    readonly snapshot?: PermissionSnapshot;
  },
): Promise<readonly OverlayHeldPost[]> {
  const tree = input.tree ?? (await loadForumTree(sql));
  const snapshot =
    input.snapshot ??
    (await loadPermissionSnapshot(sql, input.memberId, {
      tree,
      sessionId: input.sessionId,
    }));
  const rows = (await sql`
    SELECT p.id::text AS post_id, p.topic_id::text AS topic_id, t.slug AS topic_slug,
      t.forum_id::text AS forum_id, p.position, p.body_html, p.body_html_unfiltered,
      p.body_text, p.render_version, p.sanitiser_version, p.created_at,
      author.display_name AS author_name
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    LEFT JOIN core.members author ON author.id = p.author_id
    WHERE p.topic_id = ${input.topicId}
      AND p.visibility = 'unapproved'
      AND p.author_id = ${input.memberId}
    ORDER BY p.position
    LIMIT ${OVERLAY_HELD_LIMIT}
  `) as HeldPostRow[];

  if (rows.length === 0) {
    return [];
  }

  const forumId = rows[0]?.forum_id;

  if (forumId === undefined) {
    return [];
  }

  if (
    (await can(sql, input.memberId, "see_unapproved", {
      forumId,
      tree,
      snapshot,
      sessionId: input.sessionId,
    })) ||
    !(await can(sql, input.memberId, "read", {
      forumId,
      tree,
      snapshot,
      sessionId: input.sessionId,
    }))
  ) {
    return [];
  }

  const embedProviders = await listEmbedProviders(sql);
  const replaceWords = await loadReplaceWords(sql);
  const bodies = await resolveHeldBodies(
    sql,
    rows.map((row) => ({
      postId: row.post_id,
      bodyHtml: row.body_html,
      bodyHtmlUnfiltered: row.body_html_unfiltered,
      bodyText: row.body_text,
      renderVersion: row.render_version,
      sanitiserVersion: row.sanitiser_version,
    })),
    input.memberId,
    tree,
    snapshot,
    input.sessionId,
    embedProviders,
    input.translate,
    replaceWords,
  );

  return rows.map((row) => ({
    postId: row.post_id,
    topicId: row.topic_id,
    position: row.position,
    authorName: row.author_name ?? "",
    bodyHtml: bodies.get(row.post_id) ?? row.body_html,
    createdAt: row.created_at.toISOString(),
    href: canonicalUrl("topic", row.topic_id, row.topic_slug, { postId: row.post_id }),
  }));
}

interface HeldTopicRow {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly forum_id: string;
  readonly hold_reason: string | null;
  readonly created_at: Date;
}

/** The viewer's own held topics for one forum list; moderators get them in shared HTML. */
export async function heldTopicsForOverlay(
  sql: SQL,
  input: {
    readonly memberId: string;
    readonly forumId: string;
    readonly sessionId: string | null;
    readonly tree?: ForumTree;
    readonly snapshot?: PermissionSnapshot;
  },
): Promise<readonly OverlayHeldTopic[]> {
  const tree = input.tree ?? (await loadForumTree(sql));
  const snapshot =
    input.snapshot ??
    (await loadPermissionSnapshot(sql, input.memberId, {
      tree,
      sessionId: input.sessionId,
    }));

  if (
    (await can(sql, input.memberId, "see_unapproved", {
      forumId: input.forumId,
      tree,
      snapshot,
      sessionId: input.sessionId,
    })) ||
    !(await can(sql, input.memberId, "read", {
      forumId: input.forumId,
      tree,
      snapshot,
      sessionId: input.sessionId,
    }))
  ) {
    return [];
  }

  const rows = (await sql`
    SELECT id::text AS id, title, slug, forum_id::text AS forum_id, hold_reason, created_at
    FROM core.topics
    WHERE forum_id = ${input.forumId}
      AND visibility = 'unapproved'
      AND starter_id = ${input.memberId}
    ORDER BY created_at, id
    LIMIT ${OVERLAY_HELD_LIMIT}
  `) as HeldTopicRow[];
  const replaceWords = await loadReplaceWords(sql);

  return rows.map((row) => ({
    topicId: row.id,
    title: replaceWordsInText(row.title, replaceWords),
    href: canonicalUrl("topic", row.id, row.slug),
    createdAt: row.created_at.toISOString(),
    reason: row.hold_reason,
  }));
}
