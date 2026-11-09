export interface VersionedValue<T> {
  readonly version: string;
  readonly value: T;
}

export interface VersionedValueSource<K, T> {
  version(key: K): Promise<string>;
  load(key: K): Promise<T>;
}

export interface VersionedCacheOptions {
  /** How many times a read is retried when a writer bumps the tag mid-load. */
  readonly maxAttempts?: number;
}

export interface VersionedCache<K, T> {
  get(key: K): Promise<VersionedValue<T>>;
  invalidate(key?: K): void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Caches values against a durable tag version. A cached value is only reused when the tag
 * version is unchanged; a writer that bumps the tag during a load makes the read retry.
 */
export function createVersionedCache<K, T>(
  source: VersionedValueSource<K, T>,
  options: VersionedCacheOptions = {},
): VersionedCache<K, T> {
  const entries = new Map<K, VersionedValue<T>>();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  return {
    async get(key) {
      let last: VersionedValue<T> | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const before = await source.version(key);
        const cached = entries.get(key);

        if (cached !== undefined && cached.version === before) {
          return cached;
        }

        const value = await source.load(key);
        const after = await source.version(key);
        last = { version: after, value };

        if (before === after) {
          entries.set(key, last);
          return last;
        }
      }

      if (last === null) {
        throw new Error("Versioned cache could not load a value");
      }

      return last;
    },

    invalidate(key) {
      if (key === undefined) {
        entries.clear();
      } else {
        entries.delete(key);
      }
    },
  };
}
