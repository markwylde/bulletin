import type { SQL } from "bun";
import {
  etagFor,
  type ListOptions,
  type ListResult,
  type ObjectStore,
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
}

function toObject(row: ObjectRow): StoredObject {
  return {
    bucket: row.bucket,
    key: row.key,
    body: new Uint8Array(row.body),
    contentType: row.content_type,
    etag: row.etag,
    metadata: row.metadata ?? {},
    lastModified: new Date(row.last_modified),
  };
}

/** Postgres-backed storage; objects survive mock container restarts (ADR 0003). */
export async function createPostgresStore(sql: SQL): Promise<ObjectStore> {
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

  return {
    async put(input: PutInput): Promise<StoredObject> {
      const contentType = input.contentType ?? "application/octet-stream";
      const metadata = input.metadata ?? {};
      const rows = (await sql`
        INSERT INTO mock_s3.objects (bucket, key, body, content_type, etag, metadata, last_modified)
        VALUES (
          ${input.bucket},
          ${input.key},
          ${input.body},
          ${contentType},
          ${etagFor(input.body)},
          ${JSON.stringify(metadata)}::jsonb,
          now()
        )
        ON CONFLICT (bucket, key) DO UPDATE SET
          body = excluded.body,
          content_type = excluded.content_type,
          etag = excluded.etag,
          metadata = excluded.metadata,
          last_modified = excluded.last_modified
        RETURNING bucket, key, body, content_type, etag, metadata, last_modified
      `) as ObjectRow[];

      const row = rows[0];

      if (row === undefined) {
        throw new Error("mock-s3: insert returned no row");
      }

      return toObject(row);
    },

    async get(bucket: string, key: string): Promise<StoredObject | null> {
      const rows = (await sql`
        SELECT bucket, key, body, content_type, etag, metadata, last_modified
        FROM mock_s3.objects
        WHERE bucket = ${bucket} AND key = ${key}
      `) as ObjectRow[];

      const row = rows[0];
      return row === undefined ? null : toObject(row);
    },

    async delete(bucket: string, key: string): Promise<void> {
      await sql`DELETE FROM mock_s3.objects WHERE bucket = ${bucket} AND key = ${key}`;
    },

    async list(bucket: string, options: ListOptions = {}): Promise<ListResult> {
      const prefix = options.prefix ?? "";
      const maxKeys = Math.min(Math.max(options.maxKeys ?? 1000, 1), 1000);
      const token = options.continuationToken ?? null;
      const rows = (await sql`
        SELECT bucket, key, body, content_type, etag, metadata, last_modified
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
  };
}
