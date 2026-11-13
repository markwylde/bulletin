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
      sql([
        {
          capabilities: ["events"],
          enabled: true,
          state: "active",
          service_principal_group: "Guests",
          elevated_grants: [],
        },
      ]),
      request(CALL),
      { token: TOKEN, now: () => NOW },
    );

    expect(response.status).toBe(403);
  });

  test("denies a disabled plugin", async () => {
    const response = await pluginCoreResponse(
      sql([
        {
          capabilities: ["core.read"],
          enabled: false,
          state: "disabled",
          service_principal_group: "Guests",
          elevated_grants: [],
        },
      ]),
      request(CALL),
      { token: TOKEN, now: () => NOW },
    );

    expect(response.status).toBe(403);
  });
});
