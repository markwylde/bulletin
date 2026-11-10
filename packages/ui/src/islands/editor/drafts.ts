export interface EditorDraft {
  readonly contextKey: string;
  readonly bodyMd: string;
  readonly updatedAt: string;
}

interface SessionView {
  readonly authenticated?: boolean;
  readonly csrfToken?: string | null;
}

const DRAFTS = "/api/me/drafts";

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
