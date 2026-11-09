import { describe, expect, test } from "bun:test";
import {
  type AuthFetchStorage,
  clearStashedRequest,
  createAuthFetch,
  reauthUrl,
  type StashedRequest,
  stashedBodyInit,
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

function reauthFetch(storage: MemoryStorage, requests: StashedRequest[] = []) {
  return createAuthFetch({
    storage,
    fetch: async () => Response.json({ code: "reauth_required" }, { status: 401 }),
    onReauthRequired(request) {
      requests.push(request);
    },
  });
}

describe("auth fetch wrapper", () => {
  test("keeps an init string body when the session needs re-auth", async () => {
    const storage = new MemoryStorage();
    const requests: StashedRequest[] = [];
    const authFetch = reauthFetch(storage, requests);

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
      body: {
        kind: "text",
        value: '{"body":"unsent"}',
        contentType: "application/json",
      },
    });
    expect(takeStashedRequest(storage)).toEqual(requests[0] ?? null);

    clearStashedRequest(storage);
    expect(takeStashedRequest(storage)).toBeNull();
  });

  test("preserves a Request body instead of dropping it", async () => {
    const storage = new MemoryStorage();
    const authFetch = reauthFetch(storage);
    const request = new Request("http://bulletin.localhost/api/drafts/4", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"body":"from-request"}',
    });

    await authFetch(request);

    const stashed = takeStashedRequest(storage);
    expect(stashed?.url).toBe("http://bulletin.localhost/api/drafts/4");
    expect(stashed?.body).toEqual({
      kind: "text",
      value: '{"body":"from-request"}',
      contentType: "application/json",
    });
    expect(stashedBodyInit(stashed?.body ?? null)).toBe('{"body":"from-request"}');
  });

  test("preserves binary and form bodies faithfully", async () => {
    const storage = new MemoryStorage();
    const authFetch = reauthFetch(storage);
    const bytes = new Uint8Array([0, 1, 2, 255]);

    await authFetch("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    const binary = takeStashedRequest(storage);
    expect(binary?.body?.kind).toBe("bytes");
    expect(stashedBodyInit(binary?.body ?? null)).toEqual(bytes);

    await authFetch("/api/form", {
      method: "POST",
      body: new URLSearchParams({ name: "Ada" }),
    });
    const form = takeStashedRequest(storage);
    expect(form?.body).toMatchObject({ kind: "text", value: "name=Ada" });
    expect(form?.headers["content-type"]).toContain("application/x-www-form-urlencoded");

    const multipart = new FormData();
    multipart.set("name", "Ada");
    await authFetch("/api/form", { method: "POST", body: multipart });
    const uploaded = takeStashedRequest(storage);
    expect(uploaded?.body?.kind).toBe("bytes");
    expect(uploaded?.headers["content-type"]).toContain("multipart/form-data");
    expect(stashedBodyInit(uploaded?.body ?? null)).toBeInstanceOf(Uint8Array);
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
