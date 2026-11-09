import { describe, expect, test } from "bun:test";
import {
  type AuthFetchStorage,
  clearStashedRequest,
  createAuthFetch,
  reauthUrl,
  type StashedRequest,
  takeStashedRequest,
} from "./fetch.ts";

class MemoryStorage implements AuthFetchStorage {
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

describe("auth fetch wrapper", () => {
  test("keeps the unsent body when the session needs re-auth", async () => {
    const storage = new MemoryStorage();
    const requests: StashedRequest[] = [];
    const authFetch = createAuthFetch({
      storage,
      fetch: async () => Response.json({ code: "reauth_required" }, { status: 401 }),
      onReauthRequired(request) {
        requests.push(request);
      },
    });

    const response = await authFetch("/api/drafts/3", {
      method: "post",
      headers: { "content-type": "application/json" },
      body: '{"body":"unsent"}',
    });

    expect(response.status).toBe(401);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: "/api/drafts/3",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"body":"unsent"}',
    });
    expect(takeStashedRequest(storage)).toEqual(requests[0] ?? null);

    clearStashedRequest(storage);
    expect(takeStashedRequest(storage)).toBeNull();
  });

  test("passes normal and non-reauth failures through unchanged", async () => {
    const storage = new MemoryStorage();
    const ok = createAuthFetch({
      storage,
      fetch: async () => Response.json({ ok: true }),
    });
    expect((await ok("/api/anything")).status).toBe(200);

    const denied = createAuthFetch({
      storage,
      fetch: async () => Response.json({ code: "forbidden" }, { status: 401 }),
    });
    expect((await denied("/api/anything")).status).toBe(401);
    expect(takeStashedRequest(storage)).toBeNull();
  });

  test("builds a safe re-auth URL for same-origin paths only", () => {
    expect(reauthUrl("/topic/12-welcome?page=2")).toBe(
      "/api/auth/refresh?return_to=%2Ftopic%2F12-welcome%3Fpage%3D2",
    );
    expect(reauthUrl("https://evil.test/steal")).toBe("/api/auth/refresh?return_to=%2F");
  });
});
