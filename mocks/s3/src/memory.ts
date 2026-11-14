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

interface Noncurrent {
  readonly object: StoredObject | null;
  readonly key: string;
  readonly bucket: string;
  readonly versionId: string;
  /** When it stopped being current (or, for a delete marker, when it was created). */
  readonly since: Date;
}

/** In-memory store used by unit tests; production-like local runs use Postgres. */
export function createMemoryStore(
  options: { readonly now?: () => Date; readonly noncurrentDays?: number } = {},
): ObjectStore {
  const now = options.now ?? (() => new Date());
  const retentionMs = (options.noncurrentDays ?? NONCURRENT_VERSION_DAYS) * 86_400_000;
  const objects = new Map<string, StoredObject>();
  /** Newest last. A null object is a delete marker. */
  const history: Noncurrent[] = [];

  const id = (bucket: string, key: string) => `${bucket}\u0000${key}`;

  const expire = () => {
    const cutoff = now().getTime() - retentionMs;

    for (let index = history.length - 1; index >= 0; index -= 1) {
      if ((history[index]?.since.getTime() ?? 0) < cutoff) {
        history.splice(index, 1);
      }
    }
  };

  const retire = (bucket: string, key: string, marker: boolean) => {
    const current = objects.get(id(bucket, key));
    const at = now();

    if (current !== undefined) {
      history.push({ object: current, key, bucket, versionId: current.versionId, since: at });
      objects.delete(id(bucket, key));
    }

    if (marker && current !== undefined) {
      history.push({ object: null, key, bucket, versionId: newVersionId(), since: at });
    }

    expire();
  };

  return {
    async put(input: PutInput): Promise<StoredObject> {
      retire(input.bucket, input.key, false);
      const object: StoredObject = {
        bucket: input.bucket,
        key: input.key,
        body: input.body,
        contentType: input.contentType ?? "application/octet-stream",
        etag: etagFor(input.body),
        metadata: input.metadata ?? {},
        lastModified: now(),
        versionId: newVersionId(),
      };

      objects.set(id(input.bucket, input.key), object);
      return object;
    },

    async get(bucket: string, key: string): Promise<StoredObject | null> {
      return objects.get(id(bucket, key)) ?? null;
    },

    async delete(bucket: string, key: string): Promise<void> {
      retire(bucket, key, true);
    },

    async list(bucket: string, listOptions: ListOptions = {}): Promise<ListResult> {
      const prefix = listOptions.prefix ?? "";
      const maxKeys = Math.min(Math.max(listOptions.maxKeys ?? 1000, 1), 1000);
      const all = [...objects.values()]
        .filter((object) => object.bucket === bucket && object.key.startsWith(prefix))
        .sort((left, right) => left.key.localeCompare(right.key));
      const start = listOptions.continuationToken
        ? all.findIndex((object) => object.key > (listOptions.continuationToken ?? ""))
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

    async listVersions(bucket: string, prefix: string): Promise<readonly ObjectVersion[]> {
      expire();
      const versions: Array<ObjectVersion & { readonly order: number }> = [];

      for (const [order, entry] of history.entries()) {
        if (entry.bucket === bucket && entry.key.startsWith(prefix)) {
          versions.push({
            key: entry.key,
            versionId: entry.versionId,
            isLatest: false,
            deleteMarker: entry.object === null,
            size: entry.object?.body.byteLength ?? 0,
            etag: entry.object?.etag ?? "",
            lastModified: entry.object === null ? entry.since : entry.object.lastModified,
            order,
          });
        }
      }

      for (const object of objects.values()) {
        if (object.bucket === bucket && object.key.startsWith(prefix)) {
          versions.push({
            key: object.key,
            versionId: object.versionId,
            isLatest: true,
            deleteMarker: false,
            size: object.body.byteLength,
            etag: object.etag,
            lastModified: object.lastModified,
            order: Number.MAX_SAFE_INTEGER,
          });
        }
      }

      const sorted = versions.sort((left, right) =>
        left.key === right.key ? right.order - left.order : left.key.localeCompare(right.key),
      );
      // Without a current object, the newest delete marker is the latest version.
      return sorted.map(({ order: _order, ...version }, index) => ({
        ...version,
        isLatest:
          version.isLatest || (version.deleteMarker && sorted[index - 1]?.key !== version.key),
      }));
    },

    async getVersion(bucket: string, key: string, versionId: string) {
      const current = objects.get(id(bucket, key));

      if (current?.versionId === versionId) {
        return current;
      }

      return (
        history.find(
          (entry) => entry.bucket === bucket && entry.key === key && entry.versionId === versionId,
        )?.object ?? null
      );
    },
  };
}
