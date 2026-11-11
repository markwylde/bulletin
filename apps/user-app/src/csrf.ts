import { CSRF_STORAGE_KEY } from "@bulletin/domain/auth/browser";

export interface ClientSession {
  readonly authenticated: boolean;
  readonly csrfToken: string | null;
}

/** Reads the session's CSRF token on demand; shared pages must never embed it (ADR 0006). */
export async function readClientSession(): Promise<ClientSession> {
  try {
    const response = await fetch("/api/auth/session", {
      headers: { accept: "application/json" },
    });
    const body = (await response.json()) as {
      readonly authenticated?: boolean;
      readonly csrfToken?: string | null;
    };

    return {
      authenticated: body.authenticated === true,
      csrfToken: typeof body.csrfToken === "string" ? body.csrfToken : null,
    };
  } catch {
    return { authenticated: false, csrfToken: null };
  }
}

/**
 * The CSRF token for a member write: the overlay stores it, with a session-endpoint fallback
 * for pages opened before any overlay ran (ADR 0018).
 */
export async function clientCsrfToken(): Promise<string | null> {
  try {
    const stored = sessionStorage.getItem(CSRF_STORAGE_KEY);

    if (stored !== null) {
      return stored;
    }
  } catch {
    // Private mode: fall through to the session endpoint.
  }

  const session = await readClientSession();

  if (session.csrfToken !== null) {
    try {
      sessionStorage.setItem(CSRF_STORAGE_KEY, session.csrfToken);
    } catch {
      // The request still carries the token.
    }
  }

  return session.csrfToken;
}

/** Reads a server-rendered JSON label block by element id. */
export function readLabels<T>(id: string): T | null {
  const element = document.getElementById(id);

  if (element === null) {
    return null;
  }

  try {
    return JSON.parse(element.textContent ?? "") as T;
  } catch {
    return null;
  }
}
