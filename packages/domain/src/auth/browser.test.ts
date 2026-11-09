import { describe, expect, test } from "bun:test";
import { CSRF_STORAGE_KEY, type LogoutStorage, performLogout } from "./browser.ts";

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
