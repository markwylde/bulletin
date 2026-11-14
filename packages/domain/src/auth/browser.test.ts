import { describe, expect, test } from "bun:test";
import {
  AccessDeniedError,
  CSRF_STORAGE_KEY,
  type LogoutStorage,
  loadSession,
  logout,
  performLogout,
  ReauthRequiredError,
  SessionRevokedError,
  submitIdToken,
} from "./browser.ts";

class MemoryStorage implements LogoutStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("logout", () => {
  test("uses the CSRF token from a reauth_required response after grace", async () => {
    const storage = new MemoryStorage();
    let clearStashed = false;
    let clearLocalData = false;
    let redirect = "";
    const headersSeen: Array<Record<string, string>> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/auth/session") {
        return Response.json(
          { code: "reauth_required", csrfToken: "grace-token" },
          { status: 401 },
        );
      }

      headersSeen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(null, { status: 204 });
    };

    const ok = await performLogout({
      fetch,
      storage,
      redirect: (url) => {
        redirect = url;
      },
      clearStashed: () => {
        clearStashed = true;
      },
      clearLocalData: () => {
        clearLocalData = true;
      },
    });

    expect(ok).toBe(true);
    expect(headersSeen).toEqual([
      {
        "content-type": "application/json",
        "x-bulletin-csrf": "grace-token",
      },
    ]);
    expect(storage.getItem(CSRF_STORAGE_KEY)).toBeNull();
    expect(clearStashed).toBe(true);
    expect(clearLocalData).toBe(true);
    expect(redirect).toBe("/");
  });

  test("falls back to the cached token and keeps it if logout fails", async () => {
    const storage = new MemoryStorage();
    storage.setItem(CSRF_STORAGE_KEY, "cached-token");
    let clearStashed = false;
    let redirect = "";
    const headersSeen: Array<Record<string, string>> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/auth/session") {
        return Response.json({ code: "reauth_required" }, { status: 401 });
      }

      headersSeen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(null, { status: 403 });
    };

    const ok = await performLogout({
      fetch,
      storage,
      redirect: (url) => {
        redirect = url;
      },
      clearStashed: () => {
        clearStashed = true;
      },
    });

    expect(ok).toBe(false);
    expect(headersSeen[0]?.["x-bulletin-csrf"]).toBe("cached-token");
    expect(storage.getItem(CSRF_STORAGE_KEY)).toBe("cached-token");
    expect(clearStashed).toBe(false);
    expect(redirect).toBe("");
  });

  test("uses the token from an authenticated session response", async () => {
    const storage = new MemoryStorage();
    const headersSeen: Array<Record<string, string>> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/auth/session") {
        return Response.json({ authenticated: true, csrfToken: "live-token" });
      }

      headersSeen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(null, { status: 200 });
    };

    const ok = await performLogout({
      fetch,
      storage,
      redirect: () => undefined,
      clearStashed: () => undefined,
    });

    expect(ok).toBe(true);
    expect(headersSeen[0]?.["x-bulletin-csrf"]).toBe("live-token");
    expect(storage.getItem(CSRF_STORAGE_KEY)).toBeNull();
  });

  test("reports failure when the logout request errors", async () => {
    const storage = new MemoryStorage();
    const fetch = async (input: string | URL | Request) => {
      if (String(input) === "/api/auth/session") {
        return Response.json({ authenticated: true, csrfToken: "live-token" });
      }

      throw new TypeError("network down");
    };

    const ok = await performLogout({
      fetch,
      storage,
      redirect: () => undefined,
      clearStashed: () => undefined,
    });

    expect(ok).toBe(false);
  });
});

describe("logout() global wrapper", () => {
  test("calls fetch without a foreign receiver", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const original = {
      fetch: globals.fetch,
      sessionStorage: globals.sessionStorage,
      location: globals.location,
    };
    const storage = new MemoryStorage();
    const calls: string[] = [];
    let redirected = "";

    // Chrome rejects the native fetch when a caller invokes it as an object's property.
    globals.fetch = function (this: unknown, input: string | URL | Request) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }

      const url = String(input);
      calls.push(url);

      return Promise.resolve(
        url === "/api/auth/session"
          ? Response.json({ authenticated: true, csrfToken: "live-token" })
          : new Response(null, { status: 204 }),
      );
    };
    globals.sessionStorage = storage;
    globals.location = {
      replace: (url: string) => {
        redirected = url;
      },
    };

    try {
      expect(await logout()).toBe(true);
      expect(calls).toEqual(["/api/auth/session", "/api/auth/logout"]);
      expect(redirected).toBe("/");
    } finally {
      globals.fetch = original.fetch;
      globals.sessionStorage = original.sessionStorage;
      globals.location = original.location;
    }
  });
});

describe("session bootstrap failures", () => {
  async function withSessionResponse(
    body: unknown,
    status: number,
    run: () => Promise<void>,
  ): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json(body, { status })) as unknown as typeof fetch;

    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  }

  test("a reauth_required 401 asks the member to continue", async () => {
    await withSessionResponse({ code: "reauth_required" }, 401, async () => {
      await expect(loadSession()).rejects.toBeInstanceOf(ReauthRequiredError);
    });
  });

  test("a 401 without reauth_required means the session was revoked", async () => {
    await withSessionResponse({ code: "session_revoked" }, 401, async () => {
      await expect(loadSession()).rejects.toBeInstanceOf(SessionRevokedError);
    });
  });
});

describe("session submission", () => {
  test("treats a 403 response as access denied", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ code: "forbidden" }, { status: 403 })) as unknown as typeof fetch;

    try {
      await expect(submitIdToken("id-token")).rejects.toBeInstanceOf(AccessDeniedError);
    } finally {
      globalThis.fetch = original;
    }
  });
});
