import { createHash } from "node:crypto";

export interface StoredObject {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
  readonly metadata: Record<string, string>;
  readonly lastModified: Date;
}

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
}

export function etagFor(body: Uint8Array): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}
