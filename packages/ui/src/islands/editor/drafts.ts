export interface EditorDraft {
  readonly contextKey: string;
  readonly bodyMd: string;
  readonly updatedAt: string;
}

interface SessionView {
  readonly authenticated?: boolean;
  readonly csrfToken?: string | null;
  readonly memberId?: string | null;
}

const DRAFTS = "/api/me/drafts";

/** The minimal `localStorage` surface the re-auth draft store needs (fakeable in tests). */
export interface LocalStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const REAUTH_PREFIX = "bulletin:draft:reauth:";
const OWNER_KEY = "bulletin:draft:owner";

function defaultStore(): LocalStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Private mode.
    return null;
  }
}

/**
 * Re-auth drafts are keyed by the authenticated member as well as the editor context: a shared
 * browser must never offer one account's private text to another (ADR 0014).
 */
export function reauthDraftKey(memberId: string, contextKey: string): string {
  return `${REAUTH_PREFIX}${memberId}:${contextKey}`;
}

export function readReauthDraft(
  memberId: string,
  contextKey: string,
  store: LocalStore | null = defaultStore(),
): string | null {
  if (store === null) {
    return null;
  }

  try {
    const raw = store.getItem(reauthDraftKey(memberId, contextKey));

    if (raw === null) {
      return null;
    }

    const parsed = JSON.parse(raw) as { readonly bodyMd?: unknown };
    return typeof parsed.bodyMd === "string" ? parsed.bodyMd : null;
  } catch {
    return null;
  }
}

export function writeReauthDraft(
  memberId: string,
  contextKey: string,
  bodyMd: string,
  store: LocalStore | null = defaultStore(),
): void {
  if (store === null) {
    return;
  }

  try {
    store.setItem(
      reauthDraftKey(memberId, contextKey),
      JSON.stringify({ bodyMd, savedAt: Date.now(), memberId }),
    );
  } catch {
    // Private mode: the server draft may still be available after re-auth.
  }
}

export function clearReauthDraft(
  memberId: string,
  contextKey: string,
  store: LocalStore | null = defaultStore(),
): void {
  try {
    store?.removeItem(reauthDraftKey(memberId, contextKey));
  } catch {
    // Private mode.
  }
}

function reauthDraftKeys(store: LocalStore): string[] {
  const keys: string[] = [];

  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);

    if (key?.startsWith(REAUTH_PREFIX) === true) {
      keys.push(key);
    }
  }

  return keys;
}

/** Clears every local draft; called on logout and session revocation (ADR 0014, ADR 0018). */
export function clearReauthDrafts(store: LocalStore | null = defaultStore()): void {
  if (store === null) {
    return;
  }

  try {
    for (const key of reauthDraftKeys(store)) {
      store.removeItem(key);
    }

    store.removeItem(OWNER_KEY);
  } catch {
    // Private mode.
  }
}

/**
 * Claims the local draft store for the signed-in member. Any draft left behind by a different
 * account is discarded first, so an account switch can never surface the previous member's text.
 * Returns whether drafts of another account were cleared.
 */
export function claimReauthDrafts(
  memberId: string,
  store: LocalStore | null = defaultStore(),
): boolean {
  if (store === null) {
    return false;
  }

  try {
    const owner = store.getItem(OWNER_KEY);
    const changed = owner !== memberId;

    if (changed) {
      for (const key of reauthDraftKeys(store)) {
        store.removeItem(key);
      }
    }

    store.setItem(OWNER_KEY, memberId);
    return changed;
  } catch {
    return false;
  }
}

/** The editor only asks for a draft when a member session exists. */
export async function readEditorSession(): Promise<SessionView | null> {
  try {
    const response = await fetch("/api/auth/session", {
      headers: { accept: "application/json" },
    });
    return (await response.json()) as SessionView;
  } catch {
    return null;
  }
}

export async function readDraft(contextKey: string): Promise<EditorDraft | null> {
  try {
    const response = await fetch(`${DRAFTS}?contextKey=${encodeURIComponent(contextKey)}`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as { draft?: EditorDraft | null };
    return body.draft ?? null;
  } catch {
    return null;
  }
}

export async function writeDraft(
  contextKey: string,
  bodyMd: string,
  csrfToken: string,
): Promise<EditorDraft | null> {
  const response = await fetch(DRAFTS, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-bulletin-csrf": csrfToken,
    },
    body: JSON.stringify({ contextKey, bodyMd }),
  });

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as { draft?: EditorDraft | null };
  return body.draft ?? null;
}

/** Called by the posting flow after a successful submit. */
export async function clearDraft(contextKey: string, csrfToken: string): Promise<boolean> {
  const response = await fetch(`${DRAFTS}?contextKey=${encodeURIComponent(contextKey)}`, {
    method: "DELETE",
    headers: { "x-bulletin-csrf": csrfToken },
  });

  return response.ok;
}

export type DraftWrite = "save" | "clear" | "none";

const writeChains = new Map<string, Promise<void>>();

/**
 * Serialises saves and clears per draft context. Without this, a delayed save of an older body
 * can complete after a newer save or a clear and put stale content back on the server (task:
 * autosave ordering). Writes for different contexts still run independently.
 */
export function serializeDraftWrite<T>(contextKey: string, write: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(contextKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(write);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );

  writeChains.set(contextKey, tail);
  void tail.then(() => {
    if (writeChains.get(contextKey) === tail) {
      writeChains.delete(contextKey);
    }
  });

  return run;
}

/** Undoing back to the original content clears the saved draft instead of leaving it behind. */
export function draftWriteFor(initial: string, current: string, dirty: boolean): DraftWrite {
  if (!dirty) {
    return "none";
  }

  return current === initial ? "clear" : "save";
}
