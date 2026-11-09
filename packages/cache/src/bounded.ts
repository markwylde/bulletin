export interface BoundedCacheOptions {
  /** Maximum total bytes retained; least-recently-used entries are evicted first. */
  readonly maxBytes: number;
}

export interface BoundedCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V, size: number): void;
  delete(key: K): boolean;
  clear(): void;
  readonly size: number;
  readonly bytes: number;
}

interface Entry<V> {
  readonly value: V;
  readonly size: number;
}

export function createBoundedCache<K, V>(options: BoundedCacheOptions): BoundedCache<K, V> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const entries = new Map<K, Entry<V>>();
  let totalBytes = 0;

  function remove(key: K): boolean {
    const entry = entries.get(key);

    if (entry === undefined) {
      return false;
    }

    entries.delete(key);
    totalBytes -= entry.size;
    return true;
  }

  function evict(): void {
    while (totalBytes > options.maxBytes) {
      const oldest = entries.keys().next();

      if (oldest.done === true) {
        break;
      }

      remove(oldest.value);
    }
  }

  return {
    get(key) {
      const entry = entries.get(key);

      if (entry === undefined) {
        return undefined;
      }

      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },

    set(key, value, size) {
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new RangeError("Entry size must be a non-negative safe integer");
      }

      remove(key);

      if (size > options.maxBytes) {
        return;
      }

      entries.set(key, { value, size });
      totalBytes += size;
      evict();
    },

    delete: remove,

    clear() {
      entries.clear();
      totalBytes = 0;
    },

    get size() {
      return entries.size;
    },

    get bytes() {
      return totalBytes;
    },
  };
}
