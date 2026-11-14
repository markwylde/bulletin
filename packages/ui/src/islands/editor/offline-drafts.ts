/**
 * The offline draft queue (ADR 0014). Only the member's own unsent text is stored, in
 * IndexedDB on the device; forum content never is. A draft is keyed to the member who wrote it
 * so an account switch cannot surface it to the next person using the browser.
 */

export interface OfflineDraft {
  readonly id: string;
  readonly memberId: string;
  /** The editor context key, e.g. `reply:topic:12`. */
  readonly contextKey: string;
  readonly url: string;
  /** The JSON request body, exactly as the API will receive it. */
  readonly body: string;
  readonly createdAt: string;
}

export interface OfflineDraftStore {
  list(memberId: string): Promise<readonly OfflineDraft[]>;
  put(draft: OfflineDraft): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = "bulletin-offline";
const STORE_NAME = "drafts";
const DB_VERSION = 1;

/** An in-memory store for unit tests and environments where IndexedDB is unavailable. */
export class MemoryOfflineDraftStore implements OfflineDraftStore {
  readonly drafts = new Map<string, OfflineDraft>();

  async list(memberId: string): Promise<readonly OfflineDraft[]> {
    return [...this.drafts.values()]
      .filter((draft) => draft.memberId === memberId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async put(draft: OfflineDraft): Promise<void> {
    this.drafts.set(draft.id, draft);
  }

  async remove(id: string): Promise<void> {
    this.drafts.delete(id);
  }

  async clear(): Promise<void> {
    this.drafts.clear();
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

class IndexedDbOfflineDraftStore implements OfflineDraftStore {
  private readonly opening: Promise<IDBDatabase>;

  constructor(factory: IDBFactory) {
    this.opening = new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;

        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
    });
  }

  private async store(
    mode: IDBTransactionMode,
  ): Promise<{ store: IDBObjectStore; done: Promise<void> }> {
    const database = await this.opening;
    const transaction = database.transaction(STORE_NAME, mode);

    return { store: transaction.objectStore(STORE_NAME), done: transactionDone(transaction) };
  }

  async list(memberId: string): Promise<readonly OfflineDraft[]> {
    const { store, done } = await this.store("readonly");
    const drafts = await requestResult(store.getAll() as IDBRequest<OfflineDraft[]>);
    await done;

    return drafts
      .filter((draft) => draft.memberId === memberId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async put(draft: OfflineDraft): Promise<void> {
    const { store, done } = await this.store("readwrite");
    store.put(draft);
    await done;
  }

  async remove(id: string): Promise<void> {
    const { store, done } = await this.store("readwrite");
    store.delete(id);
    await done;
  }

  async clear(): Promise<void> {
    const { store, done } = await this.store("readwrite");
    store.clear();
    await done;
  }
}

function browserIndexedDb(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

let defaultStore: Promise<OfflineDraftStore> | undefined;

/** The device store, or a memory store when the browser denies IndexedDB (private mode). */
export function offlineDraftStore(): Promise<OfflineDraftStore> {
  if (defaultStore === undefined) {
    const factory = browserIndexedDb();
    defaultStore = Promise.resolve(
      factory === null ? new MemoryOfflineDraftStore() : new IndexedDbOfflineDraftStore(factory),
    );
  }

  return defaultStore;
}

export interface NewOfflineDraft {
  readonly memberId: string;
  readonly contextKey: string;
  readonly url: string;
  readonly body: string;
}

let fallbackId = 0;

function draftId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    fallbackId += 1;
    return `${Date.now()}-${fallbackId}`;
  }
}

/** Saves an unsent submission after a network failure. Returns null without a member. */
export async function saveOfflineDraft(
  input: NewOfflineDraft,
  store?: OfflineDraftStore,
): Promise<OfflineDraft | null> {
  if (input.memberId === "") {
    return null;
  }

  const draft: OfflineDraft = {
    ...input,
    id: draftId(),
    createdAt: new Date().toISOString(),
  };

  try {
    await (store ?? (await offlineDraftStore())).put(draft);
    return draft;
  } catch {
    return null;
  }
}

export async function listOfflineDrafts(
  memberId: string,
  store?: OfflineDraftStore,
): Promise<readonly OfflineDraft[]> {
  if (memberId === "") {
    return [];
  }

  try {
    return await (store ?? (await offlineDraftStore())).list(memberId);
  } catch {
    return [];
  }
}

export async function removeOfflineDraft(id: string, store?: OfflineDraftStore): Promise<void> {
  try {
    await (store ?? (await offlineDraftStore())).remove(id);
  } catch {
    // A failed cleanup leaves the draft visible rather than silently dropping it.
  }
}

/** Clears every queued draft; logout, account switch and revocation use this (ADR 0014). */
export async function clearOfflineDrafts(store?: OfflineDraftStore): Promise<void> {
  try {
    await (store ?? (await offlineDraftStore())).clear();
  } catch {
    // Private mode.
  }
}
