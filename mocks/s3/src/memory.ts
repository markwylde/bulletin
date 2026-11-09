import {
  etagFor,
  type ListOptions,
  type ListResult,
  type ObjectStore,
  type PutInput,
  type StoredObject,
} from "./types.ts";

/** In-memory store used by unit tests; production-like local runs use Postgres. */
export function createMemoryStore(): ObjectStore {
  const objects = new Map<string, StoredObject>();

  const id = (bucket: string, key: string) => `${bucket}\u0000${key}`;

  return {
    async put(input: PutInput): Promise<StoredObject> {
      const object: StoredObject = {
        bucket: input.bucket,
        key: input.key,
        body: input.body,
        contentType: input.contentType ?? "application/octet-stream",
        etag: etagFor(input.body),
        metadata: input.metadata ?? {},
        lastModified: new Date(),
      };

      objects.set(id(input.bucket, input.key), object);
      return object;
    },

    async get(bucket: string, key: string): Promise<StoredObject | null> {
      return objects.get(id(bucket, key)) ?? null;
    },

    async delete(bucket: string, key: string): Promise<void> {
      objects.delete(id(bucket, key));
    },

    async list(bucket: string, options: ListOptions = {}): Promise<ListResult> {
      const prefix = options.prefix ?? "";
      const maxKeys = Math.min(Math.max(options.maxKeys ?? 1000, 1), 1000);
      const all = [...objects.values()]
        .filter((object) => object.bucket === bucket && object.key.startsWith(prefix))
        .sort((left, right) => left.key.localeCompare(right.key));
      const start = options.continuationToken
        ? all.findIndex((object) => object.key > (options.continuationToken ?? ""))
        : 0;
      const offset = start === -1 ? all.length : Math.max(start, 0);
      const slice = all.slice(offset, offset + maxKeys);
      const next = all[offset + maxKeys];

      return {
        objects: slice,
        isTruncated: next !== undefined,
        ...(next === undefined ? {} : { nextContinuationToken: next.key }),
      };
    },
  };
}
