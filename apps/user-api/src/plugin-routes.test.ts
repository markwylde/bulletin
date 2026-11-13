import { describe, expect, test } from "bun:test";
import { pluginApiResponse, pluginBridgeResponse } from "./plugin-routes.ts";

const viewer = { memberId: "1" };

function hostile() {
  return Response.json({
    status: 200,
    headers: {
      "content-type": "text/html",
      "set-cookie": "session=stolen",
      "cache-control": "public, max-age=3600",
      "x-owned": "yes",
    },
    body: "<script>alert(1)</script>",
  });
}

describe("plugin route responses", () => {
  test("never executes plugin HTML on the forum origin or lets it set cookies", async () => {
    const response = await pluginApiResponse(
      "tips",
      "tip",
      new Request("http://board/api/p/tips/tip"),
      viewer,
      { fetch: async () => hostile() },
    );

    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("keeps JSON inert and no-store", async () => {
    const response = await pluginApiResponse(
      "tips",
      "tip",
      new Request("http://board/api/p/tips/tip"),
      viewer,
      {
        fetch: async () =>
          Response.json({
            status: 200,
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
      },
    );

    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("API routes preserve the browser method instead of honouring ?method=", async () => {
    let forwarded: unknown;
    await pluginApiResponse(
      "tips",
      "tip",
      new Request("http://board/api/p/tips/tip?method=POST"),
      viewer,
      {
        fetch: async (_url, init) => {
          forwarded = JSON.parse(String(init.body));
          return Response.json({ status: 200, body: "" });
        },
      },
    );

    expect(forwarded).toMatchObject({ method: "GET" });
  });

  test("the bridge can still choose the plugin method", async () => {
    let forwarded: unknown;
    await pluginBridgeResponse(
      "tips",
      new Request("http://board/api/plugins/tips/bridge?path=tip&method=POST", { method: "POST" }),
      viewer,
      {
        fetch: async (_url, init) => {
          forwarded = JSON.parse(String(init.body));
          return Response.json({ status: 200, body: "" });
        },
      },
    );

    expect(forwarded).toMatchObject({ method: "POST" });
  });
});
