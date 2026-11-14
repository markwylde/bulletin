import { createHash } from "node:crypto";

export interface StoredObject {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
  readonly metadata: Record<string, string>;
  readonly lastModified: Date;
  /** The version ID of this object (the bucket is versioned, like production). */
  readonly versionId: string;
}

/** A version entry for `ListObjectVersions`. */
export interface ObjectVersion {
  readonly key: string;
  readonly versionId: string;
  readonly isLatest: boolean;
  readonly deleteMarker: boolean;
  readonly size: number;
  readonly etag: string;
  readonly lastModified: Date;
}

/** ADR 0020: noncurrent versions and delete markers expire 35 days after they stop being current. */
export const NONCURRENT_VERSION_DAYS = 35;

export interface PutInput {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

export interface ListOptions {
  readonly prefix?: string;
  readonly maxKeys?: number;
  readonly continuationToken?: string;
}

export interface ListResult {
  readonly objects: readonly StoredObject[];
  readonly isTruncated: boolean;
  readonly nextContinuationToken?: string;
}

export interface ObjectStore {
  put(input: PutInput): Promise<StoredObject>;
  get(bucket: string, key: string): Promise<StoredObject | null>;
  delete(bucket: string, key: string): Promise<void>;
  list(bucket: string, options?: ListOptions): Promise<ListResult>;
  /** Every version under the prefix, newest first per key. */
  listVersions(bucket: string, prefix: string): Promise<readonly ObjectVersion[]>;
  /** A specific version; null for an unknown ID or a delete marker. */
  getVersion(bucket: string, key: string, versionId: string): Promise<StoredObject | null>;
}

export function newVersionId(): string {
  return Bun.randomUUIDv7().replaceAll("-", "");
}

export function etagFor(body: Uint8Array): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}
