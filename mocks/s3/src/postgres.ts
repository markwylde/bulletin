import type { SQL } from "bun";
import {
  etagFor,
  type ListOptions,
  type ListResult,
  NONCURRENT_VERSION_DAYS,
  newVersionId,
  type ObjectStore,
  type ObjectVersion,
  type PutInput,
  type StoredObject,
} from "./types.ts";

interface ObjectRow {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly content_type: string;
  readonly etag: string;
  readonly metadata: Record<string, string> | null;
  readonly last_modified: Date | string;
  readonly version_id: string;
}

interface VersionRow {
  readonly key: string;
  readonly version_id: string;
  readonly is_latest: boolean;
  readonly delete_marker: boolean;
  readonly size: number;
  readonly etag: string;
  readonly last_modified: Date | string;
}

function toObject(row: ObjectRow): StoredObject {
  return {
    versionId: row.version_id,
    bucket: row.bucket,
    key: row.key,
    body: new Uint8Array(row.body),
    contentType: row.content_type,
    etag: row.etag,
    metadata: row.metadata ?? {},
    lastModified: new Date(row.last_modified),
  };
}

/**
 * Postgres-backed storage; objects survive mock container restarts (ADR 0003). The bucket is
 * versioned like production: overwritten and deleted objects move to `object_versions` and
 * expire `noncurrentDays` after they stop being current (ADR 0020).
 */
export async function createPostgresStore(
  sql: SQL,
  options: { readonly noncurrentDays?: number } = {},
): Promise<ObjectStore> {
  const noncurrentDays = options.noncurrentDays ?? NONCURRENT_VERSION_DAYS;
  await sql`CREATE SCHEMA IF NOT EXISTS mock_s3`;
  await sql`
    CREATE TABLE IF NOT EXISTS mock_s3.objects (
      bucket text NOT NULL,
      key text NOT NULL,
      body bytea NOT NULL,
      content_type text NOT NULL,
      etag text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_modified timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (bucket, key)
    )
  `;
  await sql`
    ALTER TABLE mock_s3.objects
      ADD COLUMN IF NOT EXISTS version_id text NOT NULL
        DEFAULT replace(gen_random_uuid()::text, '-', '')
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS mock_s3.object_versions (
      bucket text NOT NULL,
      key text NOT NULL,
      version_id text NOT NULL,
      -- NULL body: a delete marker.
      body bytea,
      content_type text NOT NULL DEFAULT 'application/octet-stream',
      etag text NOT NULL DEFAULT '',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_modified timestamptz NOT NULL,
      noncurrent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (bucket, key, version_id)
    )
  `;

  /** Moves the current object (if any) into the version history; optionally adds a marker. */
  async function retire(bucket: string, key: string, marker: boolean): Promise<void> {
    await sql.begin(async (tx) => {
      const moved = (await tx`
        WITH gone AS (
          DELETE FROM mock_s3.objects WHERE bucket = ${bucket} AND key = ${key}
          RETURNING *
        )
        INSERT INTO mock_s3.object_versions (
          bucket, key, version_id, body, content_type, etag, metadata, last_modified
        )
        SELECT bucket, key, version_id, body, content_type, etag, metadata, last_modified
        FROM gone
        RETURNING key
      `) as Array<{ key: string }>;

      if (marker && moved.length > 0) {
        await tx`
          INSERT INTO mock_s3.object_versions (bucket, key, version_id, body, last_modified)
          VALUES (${bucket}, ${key}, ${newVersionId()}, NULL, clock_timestamp())
        `;
      }

      await tx`
        DELETE FROM mock_s3.object_versions
        WHERE noncurrent_at < now() - make_interval(days => ${noncurrentDays})
      `;
    });
  }

  return {
    async put(input: PutInput): Promise<StoredObject> {
      const contentType = input.contentType ?? "application/octet-stream";
      const metadata = input.metadata ?? {};
      await retire(input.bucket, input.key, false);
      const rows = (await sql`
        INSERT INTO mock_s3.objects (
          bucket, key, body, content_type, etag, metadata, last_modified, version_id
        )
        VALUES (
          ${input.bucket},
          ${input.key},
          ${input.body},
          ${contentType},
          ${etagFor(input.body)},
          ${JSON.stringify(metadata)}::jsonb,
          clock_timestamp(),
          ${newVersionId()}
        )
        ON CONFLICT (bucket, key) DO UPDATE SET
          body = excluded.body,
          content_type = excluded.content_type,
          etag = excluded.etag,
          metadata = excluded.metadata,
          last_modified = excluded.last_modified,
          version_id = excluded.version_id
        RETURNING bucket, key, body, content_type, etag, metadata, last_modified, version_id
      `) as ObjectRow[];

      const row = rows[0];

      if (row === undefined) {
        throw new Error("mock-s3: insert returned no row");
      }

      return toObject(row);
    },

    async get(bucket: string, key: string): Promise<StoredObject | null> {
      const rows = (await sql`
        SELECT bucket, key, body, content_type, etag, metadata, last_modified, version_id
        FROM mock_s3.objects
        WHERE bucket = ${bucket} AND key = ${key}
      `) as ObjectRow[];

      const row = rows[0];
      return row === undefined ? null : toObject(row);
    },

    async delete(bucket: string, key: string): Promise<void> {
      await retire(bucket, key, true);
    },

    async list(bucket: string, options: ListOptions = {}): Promise<ListResult> {
      const prefix = options.prefix ?? "";
      const maxKeys = Math.min(Math.max(options.maxKeys ?? 1000, 1), 1000);
      const token = options.continuationToken ?? null;
      const rows = (await sql`
        SELECT bucket, key, body, content_type, etag, metadata, last_modified, version_id
        FROM mock_s3.objects
        WHERE bucket = ${bucket}
          AND substr(key, 1, ${prefix.length}) = ${prefix}
          AND (${token}::text IS NULL OR key > ${token}::text)
        ORDER BY key
        LIMIT ${maxKeys + 1}
      `) as ObjectRow[];

      const objects = rows.slice(0, maxKeys).map(toObject);
      const isTruncated = rows.length > maxKeys;
      const last = objects.at(-1);

      return {
        objects,
        isTruncated,
        ...(isTruncated && last !== undefined ? { nextContinuationToken: last.key } : {}),
      };
    },

    async listVersions(bucket: string, prefix: string): Promise<readonly ObjectVersion[]> {
      const rows = (await sql`
        WITH all_versions AS (
          SELECT key, version_id, false AS delete_marker, octet_length(body) AS size, etag,
                 last_modified, 'infinity'::timestamptz AS ordering, true AS current
          FROM mock_s3.objects
          WHERE bucket = ${bucket} AND substr(key, 1, ${prefix.length}) = ${prefix}
          UNION ALL
          SELECT key, version_id, body IS NULL, COALESCE(octet_length(body), 0), etag,
                 last_modified, noncurrent_at, false
          FROM mock_s3.object_versions
          WHERE bucket = ${bucket} AND substr(key, 1, ${prefix.length}) = ${prefix}
            AND noncurrent_at >= now() - make_interval(days => ${noncurrentDays})
        )
        SELECT key, version_id, delete_marker, size::int AS size, etag, last_modified,
               (row_number() OVER (PARTITION BY key ORDER BY ordering DESC, last_modified DESC)
                 = 1) AS is_latest
        FROM all_versions
        ORDER BY key, ordering DESC, last_modified DESC
      `) as VersionRow[];

      return rows.map((row) => ({
        key: row.key,
        versionId: row.version_id,
        isLatest: row.is_latest,
        deleteMarker: row.delete_marker,
        size: row.size,
        etag: row.etag,
        lastModified: new Date(row.last_modified),
      }));
    },

    async getVersion(bucket: string, key: string, versionId: string) {
      const rows = (await sql`
        SELECT bucket, key, body, content_type, etag, metadata, last_modified, version_id
        FROM mock_s3.objects
        WHERE bucket = ${bucket} AND key = ${key} AND version_id = ${versionId}
        UNION ALL
        SELECT bucket, key, body, content_type, etag, metadata, last_modified, version_id
        FROM mock_s3.object_versions
        WHERE bucket = ${bucket} AND key = ${key} AND version_id = ${versionId}
          AND body IS NOT NULL
      `) as ObjectRow[];
      const row = rows[0];
      return row === undefined ? null : toObject(row);
    },
  };
}
