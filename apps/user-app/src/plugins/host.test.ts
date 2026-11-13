import { describe, expect, test } from "bun:test";
import { requestPluginRoute } from "./host.ts";

describe("plugin route client", () => {
  test("forwards the viewer and plugin path to plugin-host", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const response = await requestPluginRoute(
      {
        pluginId: "tips",
        path: "tip/7",
        method: "GET",
        query: { page: "2" },
        viewer: { memberId: "5" },
      },
      {
        url: "http://plugin-host:3004",
        token: "secret",
        fetch: async (url, init) => {
          requests.push({ url, body: JSON.parse(String(init.body)) });
          return Response.json({ status: 200, body: "ok", headers: { "x-tip": "1" } });
        },
      },
    );

    expect(requests).toEqual([
      {
        url: "http://plugin-host:3004/internal/routes",
        body: {
          pluginId: "tips",
          path: "tip/7",
          method: "GET",
          query: { page: "2" },
          viewer: { memberId: "5" },
        },
      },
    ]);
    expect(response).toEqual({ status: 200, body: "ok", headers: { "x-tip": "1" } });
  });

  test("contains a failing plugin as a 503", async () => {
    await expect(
      requestPluginRoute(
        { pluginId: "tips", path: "tip", method: "GET", viewer: { memberId: null } },
        {
          fetch: async () => {
            throw new Error("down");
          },
        },
      ),
    ).resolves.toEqual({ status: 503, body: "", headers: {} });
  });
});
