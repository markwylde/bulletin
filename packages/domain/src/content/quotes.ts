import { bumpCacheTags, postSnapshotsTag } from "@bulletin/cache";
import type { QuoteSnapshotDraft, QuoteSourceKind } from "@bulletin/content/types";
import type { SQL } from "bun";
import { type Mutation, runMutation } from "../mutations/index.ts";

export interface QuoteSourceKey {
  readonly kind: QuoteSourceKind;
  readonly id: string;
}

export interface QuoteSnapshotRecord {
  readonly id: string;
  readonly sourceKind: QuoteSourceKind;
  readonly sourceId: string;
  readonly sourceAuthorId: string | null;
  readonly bodyMd: string;
  readonly bodyHtml: string;
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
  readonly createdAt: Date;
  readonly redactedAt: Date | null;
}

interface QuoteSnapshotRow {
  readonly id: string;
  readonly source_kind: QuoteSourceKind;
  readonly source_id: string;
  readonly source_author_id: string | null;
  readonly body_md: string;
  readonly body_html: string;
  readonly render_version: number;
  readonly sanitiser_version: number;
  readonly created_at: Date;
  readonly redacted_at: Date | null;
}

function toRecord(row: QuoteSnapshotRow): QuoteSnapshotRecord {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceAuthorId: row.source_author_id,
    bodyMd: row.body_md,
    bodyHtml: row.body_html,
    renderVersion: row.render_version,
    sanitiserVersion: row.sanitiser_version,
    createdAt: row.created_at,
    redactedAt: row.redacted_at,
  };
}

/** Inserts one snapshot; callers run it inside the posting/editing transaction. */
export async function insertQuoteSnapshot(sql: SQL, draft: QuoteSnapshotDraft): Promise<string> {
  const rows = (await sql`
    INSERT INTO core.quote_snapshots (
      source_kind, source_id, source_author_id, body_md, body_html,
      render_version, sanitiser_version
    )
    VALUES (
      ${draft.sourceKind}, ${draft.sourceId}, ${draft.sourceAuthorId}, ${draft.bodyMd},
      ${draft.bodyHtml}, ${draft.renderVersion}, ${draft.sanitiserVersion}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const id = rows[0]?.id;

  if (id === undefined) {
    throw new Error("Could not insert quote snapshot");
  }

  return id;
}

/** The first snapshot stored for a source; re-renders reuse it instead of re-validating the post. */
export async function findQuoteSnapshotBySource(
  sql: SQL,
  source: QuoteSourceKey,
): Promise<QuoteSnapshotRecord | null> {
  const rows = (await sql`
    SELECT id::text AS id, source_kind, source_id::text AS source_id,
      source_author_id::text AS source_author_id, body_md, body_html,
      render_version, sanitiser_version, created_at, redacted_at
    FROM core.quote_snapshots
    WHERE source_kind = ${source.kind} AND source_id = ${source.id}
    ORDER BY id
    LIMIT 1
  `) as QuoteSnapshotRow[];

  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

export async function loadQuoteSnapshot(
  sql: SQL,
  snapshotId: string,
): Promise<QuoteSnapshotRecord | null> {
  const rows = (await sql`
    SELECT id::text AS id, source_kind, source_id::text AS source_id,
      source_author_id::text AS source_author_id, body_md, body_html,
      render_version, sanitiser_version, created_at, redacted_at
    FROM core.quote_snapshots
    WHERE id = ${snapshotId}
  `) as QuoteSnapshotRow[];

  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

function redactionTags(source: QuoteSourceKey): readonly string[] {
  // Conversation snapshots never enter shared caches; only forum quotes have a page tag.
  return source.kind === "post" ? [postSnapshotsTag(source.id)] : [];
}

/**
 * Marks every existing snapshot of a source as redacted. Every fragment that quotes the post
 * declares `post:{id}:snapshots`, so bumping it rebuilds all of them (ADR 0007).
 */
export const quoteRedactionMutation: Mutation<QuoteSourceKey, number> = {
  name: "quote.snapshots.redact",
  tags: (source, redacted) => (redacted > 0 ? redactionTags(source) : []),
};

/** Update-only form for callers already inside their own mutation transaction. */
export async function redactQuoteSnapshotsInTransaction(
  sql: SQL,
  source: QuoteSourceKey,
): Promise<number> {
  const rows = (await sql`
    UPDATE core.quote_snapshots
    SET redacted_at = now()
    WHERE source_kind = ${source.kind}
      AND source_id = ${source.id}
      AND redacted_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;

  return rows.length;
}

/** Standalone redaction with its cache-tag bump in the same transaction. */
export async function redactQuoteSnapshots(sql: SQL, source: QuoteSourceKey): Promise<number> {
  return runMutation({
    sql,
    mutation: quoteRedactionMutation,
    input: source,
    apply: (tx, key) => redactQuoteSnapshotsInTransaction(tx, key),
  });
}

/** Re-render inputs for stale snapshots, ordered by id for a resumable cursor (ADR 0007). */
export async function listStaleQuoteSnapshots(
  sql: SQL,
  versions: { readonly renderVersion: number; readonly sanitiserVersion: number },
  options: { readonly afterId?: string; readonly limit?: number } = {},
): Promise<readonly QuoteSnapshotRecord[]> {
  const limit = options.limit ?? 500;
  const afterId = options.afterId ?? "0";
  const rows = (await sql`
    SELECT id::text AS id, source_kind, source_id::text AS source_id,
      source_author_id::text AS source_author_id, body_md, body_html,
      render_version, sanitiser_version, created_at, redacted_at
    FROM core.quote_snapshots
    WHERE id > ${afterId}
      AND (render_version <> ${versions.renderVersion}
        OR sanitiser_version <> ${versions.sanitiserVersion})
    ORDER BY id
    LIMIT ${limit}
  `) as QuoteSnapshotRow[];

  return rows.map(toRecord);
}

/** Writes a re-rendered snapshot in place (used by the re-render job, task 2.1). */
export async function updateQuoteSnapshotRendering(
  sql: SQL,
  snapshotId: string,
  rendered: {
    readonly bodyHtml: string;
    readonly renderVersion: number;
    readonly sanitiserVersion: number;
  },
): Promise<void> {
  await sql`
    UPDATE core.quote_snapshots
    SET body_html = ${rendered.bodyHtml},
      render_version = ${rendered.renderVersion},
      sanitiser_version = ${rendered.sanitiserVersion}
    WHERE id = ${snapshotId}
  `;
}

/** Explicit tag helper so a caller's own mutation can declare the same invalidation. */
export function quoteSnapshotTags(source: QuoteSourceKey): readonly string[] {
  return redactionTags(source);
}

/** Exposed for tests and callers that bump tags without `runMutation`. */
export async function bumpQuoteSnapshotTags(sql: SQL, source: QuoteSourceKey): Promise<void> {
  const tags = redactionTags(source);

  if (tags.length > 0) {
    await bumpCacheTags(sql, tags);
  }
}
