import { describe, expect, test } from "bun:test";
import { coreSignature, pluginCoreResponse } from "./plugin-core.ts";

const TOKEN = "broker-secret";
const NOW = 1_700_000_000_000;

function request(
  body: object,
  options: { readonly timestamp?: number; readonly signature?: string } = {},
) {
  const text = JSON.stringify(body);
  const timestamp = String(options.timestamp ?? NOW);
  return new Request("http://board/internal/plugins/core", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-bulletin-plugin": "tips",
      "x-bulletin-timestamp": timestamp,
      "x-bulletin-signature": options.signature ?? coreSignature(TOKEN, "tips", timestamp, text),
    },
    body: text,
  });
}

const CALL = {
  pluginId: "tips",
  method: "posts.get",
  params: { postId: "1" },
  viewer: { memberId: null },
};

const WRITE_CALL = {
  pluginId: "tips",
  method: "members.addBadge",
  params: {},
  viewer: { memberId: null },
};

function pluginRow(overrides: Record<string, unknown> = {}) {
  return {
    approved_capabilities: ["core.read"],
    capabilities: ["core.read"],
    enabled: true,
    state: "active",
    service_principal_group: "Guests",
    elevated_grants: [],
    ...overrides,
  };
}

function sql(rows: readonly unknown[]) {
  return (async () => rows) as never;
}

describe("broker core forwarding", () => {
  test("rejects missing, stale and forged signatures before touching the database", async () => {
    const stale = await pluginCoreResponse(
      sql([]),
      request(CALL, { timestamp: NOW - 10 * 60_000 }),
      {
        token: TOKEN,
        now: () => NOW,
      },
    );
    expect(stale.status).toBe(401);

    const forged = await pluginCoreResponse(sql([]), request(CALL, { signature: "0".repeat(64) }), {
      token: TOKEN,
      now: () => NOW,
    });
    expect(forged.status).toBe(401);
  });

  test("denies a plugin without the core-read capability", async () => {
    const response = await pluginCoreResponse(
      sql([pluginRow({ approved_capabilities: ["events"] })]),
      request(CALL),
      { token: TOKEN, now: () => NOW },
    );

    expect(response.status).toBe(403);
  });

  test("checks the admin-approved grants, never the bundle's declared capabilities", async () => {
    const response = await pluginCoreResponse(
      sql([pluginRow({ capabilities: ["core.read"], approved_capabilities: [] })]),
      request(CALL),
      { token: TOKEN, now: () => NOW },
    );

    expect(response.status).toBe(403);
  });

  test("requires core.write for a write method even when core.read is approved", async () => {
    const response = await pluginCoreResponse(
      sql([pluginRow({ approved_capabilities: ["core.read"] })]),
      request(WRITE_CALL),
      { token: TOKEN, now: () => NOW },
    );

    expect(response.status).toBe(403);
  });

  test("lets an approved write capability reach the method, even before it is implemented", async () => {
    const response = await pluginCoreResponse(
      sql([pluginRow({ approved_capabilities: ["core.write"] })]),
      request(WRITE_CALL),
      { token: TOKEN, now: () => NOW },
    );

    expect(response.status).toBe(501);
  });

  test("denies a disabled plugin", async () => {
    const response = await pluginCoreResponse(
      sql([pluginRow({ enabled: false, state: "disabled" })]),
      request(CALL),
      { token: TOKEN, now: () => NOW },
    );

    expect(response.status).toBe(403);
  });
});
