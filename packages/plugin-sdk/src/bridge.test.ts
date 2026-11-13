import { describe, expect, test } from "bun:test";
import { createHostBridge, validateBridgeMessage } from "./bridge.ts";

const TOKEN = "instance-token";

describe("iframe bridge validation", () => {
  test("accepts only messages with the iframe's own token", () => {
    expect(validateBridgeMessage({ type: "resize", token: TOKEN, height: 120 }, TOKEN)).toEqual({
      type: "resize",
      token: TOKEN,
      height: 120,
    });
    expect(
      validateBridgeMessage({ type: "resize", token: "other", height: 120 }, TOKEN),
    ).toBeUndefined();
    expect(validateBridgeMessage({ type: "resize", height: 120 }, TOKEN)).toBeUndefined();
  });

  test("bounds resize heights and validates routes", () => {
    expect(
      validateBridgeMessage({ type: "resize", token: TOKEN, height: 99_999 }, TOKEN),
    ).toMatchObject({
      height: 4_000,
    });
    expect(
      validateBridgeMessage({ type: "route", token: TOKEN, id: "1", path: "../secret" }, TOKEN),
    ).toBeUndefined();
    expect(
      validateBridgeMessage({ type: "route", token: TOKEN, id: "1", path: "tip/2" }, TOKEN),
    ).toMatchObject({ path: "tip/2", method: "GET" });
    expect(
      validateBridgeMessage({ type: "open", token: TOKEN, url: "javascript:alert(1)" }, TOKEN),
    ).toBeUndefined();
  });
});

describe("iframe bridge host", () => {
  const view = { postId: "7" };

  function host() {
    const calls: string[] = [];
    const bridge = createHostBridge(TOKEN, {
      read: () => view,
      route: async (path, method) => ({ status: 200, body: `${method}:${path}` }),
      open: (url) => calls.push(`open:${url}`),
      toast: (key) => calls.push(`toast:${key}`),
      resize: (height) => calls.push(`resize:${height}`),
      report: (message) => calls.push(`report:${message}`),
    });

    return { bridge, calls };
  }

  test("answers read and route only on the private port", async () => {
    const { bridge } = host();

    await expect(bridge.handle({ type: "read", token: TOKEN, id: "1" })).resolves.toEqual({
      type: "bulletin:bridge:result",
      token: TOKEN,
      id: "1",
      ok: true,
      data: view,
    });
    await expect(
      bridge.handle({ type: "route", token: TOKEN, id: "2", path: "tip/2", method: "GET" }),
    ).resolves.toMatchObject({ ok: true, data: { body: "GET:tip/2" } });
  });

  test("ignores a window-style message without the per-instance token", async () => {
    const { bridge, calls } = host();

    await expect(bridge.handle({ type: "toast", messageKey: "x" })).resolves.toBeUndefined();
    await expect(
      bridge.handle({ type: "toast", token: "spoofed", messageKey: "x" }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("rate-limits a frame flooding the bridge", async () => {
    const { bridge, calls } = host();

    for (let index = 0; index < 60; index += 1) {
      await bridge.handle({ type: "resize", token: TOKEN, height: index });
    }

    expect(calls).toContain("report:bridge rate limit exceeded");
  });
});
