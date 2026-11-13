import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  CoreApiClient,
  type CoreCall,
  CoreDeniedError,
  DEFAULT_CORE_METHODS,
  GUEST_VIEWER,
} from "./core.ts";

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const api = new CoreApiClient({
    baseUrl: "http://user-api:3001",
    token: "broker-secret",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return handler(url, init);
    },
  });

  return { api, requests };
}

const POSTS_CALL: CoreCall = {
  pluginId: "test-plugin",
  method: "posts.get",
  params: { id: "42" },
  viewer: { memberId: "7", sessionId: "session-1" },
};

describe("core API client", () => {
  test("forwards an allowed method with the viewer and a signed broker token", async () => {
    const { api, requests } = client(async () => jsonResponse({ result: { id: "42" } }));

    await expect(api.call(POSTS_CALL)).resolves.toEqual({ id: "42" });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe("http://user-api:3001/internal/plugins/core");
    const headers = request?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer broker-secret");
    expect(headers["x-bulletin-plugin"]).toBe("test-plugin");

    const body = String(request?.init.body);
    expect(JSON.parse(body)).toEqual({
      pluginId: "test-plugin",
      method: "posts.get",
      params: { id: "42" },
      viewer: { memberId: "7", sessionId: "session-1" },
    });
    const expectedSignature = createHmac("sha256", "broker-secret")
      .update(`test-plugin\n${headers["x-bulletin-timestamp"]}\n${body}`)
      .digest("hex");
    expect(headers["x-bulletin-signature"]).toBe(expectedSignature);
  });

  test("defaults the viewer to guest when none is supplied", async () => {
    const { api, requests } = client(async () => jsonResponse({ result: null }));

    await api.call({ ...POSTS_CALL, viewer: GUEST_VIEWER });
    expect(JSON.parse(String(requests[0]?.init.body)).viewer).toEqual({ memberId: null });
  });

  test("rejects methods outside the SDK allowlist before any request", async () => {
    const { api, requests } = client(async () => jsonResponse({ result: null }));

    await expect(api.call({ ...POSTS_CALL, method: "core.rawQuery" })).rejects.toBeInstanceOf(
      CoreDeniedError,
    );
    expect(requests).toHaveLength(0);
    expect(DEFAULT_CORE_METHODS).toContain("posts.get");
  });

  test("keeps the allowlist configurable but never trusts the plugin", async () => {
    const api = new CoreApiClient({
      baseUrl: "http://user-api:3001",
      token: "secret",
      allowedMethods: ["topics.get"],
      fetch: async () => jsonResponse({ result: null }),
    });

    await expect(api.call(POSTS_CALL)).rejects.toMatchObject({ reason: "method" });
    await expect(api.call({ ...POSTS_CALL, method: "topics.get" })).resolves.toBeNull();
  });

  test("maps a 403 to a viewer denial", async () => {
    const { api } = client(async () => jsonResponse({ error: "denied" }, 403));

    await expect(api.call(POSTS_CALL)).rejects.toMatchObject({
      reason: "response",
      message: "Core API denied the request for this viewer",
    });
  });

  test("rejects an oversized core response", async () => {
    const api = new CoreApiClient({
      baseUrl: "http://user-api:3001",
      token: "secret",
      maxResponseBytes: 16,
      fetch: async () => new Response("x".repeat(17)),
    });

    await expect(api.call(POSTS_CALL)).rejects.toMatchObject({ reason: "size" });
  });

  test("maps network and JSON failures to core denials", async () => {
    const failed = client(async () => {
      throw new Error("boom");
    }).api;
    await expect(failed.call(POSTS_CALL)).rejects.toMatchObject({ reason: "request" });

    const invalid = client(async () => new Response("not json")).api;
    await expect(invalid.call(POSTS_CALL)).rejects.toMatchObject({ reason: "response" });
  });

  test("rejects an invalid base URL", () => {
    expect(() => new CoreApiClient({ baseUrl: "ftp://user-api", token: "secret" })).toThrow(
      "must use http or https",
    );
  });
});
