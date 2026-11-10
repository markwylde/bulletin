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
