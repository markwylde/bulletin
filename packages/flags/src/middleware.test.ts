import { describe, expect, test } from "bun:test";
import { defineFlag } from "./defaults.ts";
import { requireFlag } from "./middleware.ts";
import { createFlagRuntime } from "./runtime.ts";
import { type FlagDefinition, type FlagViewer, GUEST_VIEWER } from "./types.ts";

const MEMBER: FlagViewer = { memberId: "7", groups: ["members"] };

function runtimeFor(definitions: readonly FlagDefinition[]) {
  const runtime = createFlagRuntime({
    version: async () => "1",
    load: async () => definitions,
  });

  return runtime;
}

const ON = defineFlag({
  key: "newEditor",
  description: "Switches the new editor on.",
  owner: "content",
  default: true,
});

const OFF = defineFlag({
  key: "newEditor",
  description: "Switches the new editor on.",
  owner: "content",
  default: false,
});

describe("requireFlag route middleware", () => {
  test("answers 404 and never calls the endpoint when the flag is off", async () => {
    const runtime = runtimeFor([OFF]);
    let called = false;

    const route = requireFlag("newEditor", { runtime, viewer: () => MEMBER });
    const response = await route(new Request("http://bulletin.localhost/api/editor"), () => {
      called = true;
      return new Response("ok");
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "not_found" });
    expect(called).toBe(false);
  });

  test("runs the endpoint when the flag is on for the requester", async () => {
    const runtime = runtimeFor([ON]);

    const route = requireFlag("newEditor", { runtime, viewer: () => MEMBER });
    const response = await route(new Request("http://bulletin.localhost/api/editor"), () =>
      Response.json({ ok: true }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("uses the resolved viewer, so a group rule hides the endpoint from non-members", async () => {
    const targeted = {
      ...OFF,
      rules: [{ type: "group", groups: ["moderators"], value: true }] as const,
    };
    const runtime = runtimeFor([targeted]);
    const route = requireFlag("newEditor", {
      runtime,
      viewer: (request) =>
        request.headers.get("x-viewer") === "moderator"
          ? { memberId: "9", groups: ["members", "moderators"] }
          : GUEST_VIEWER,
    });

    const denied = await route(new Request("http://bulletin.localhost/api/editor"), () =>
      Response.json({ ok: true }),
    );
    const allowed = await route(
      new Request("http://bulletin.localhost/api/editor", {
        headers: { "x-viewer": "moderator" },
      }),
      () => Response.json({ ok: true }),
    );

    expect(denied.status).toBe(404);
    expect(allowed.status).toBe(200);
  });

  test("loads the definitions on the first request", async () => {
    let loads = 0;
    const runtime = createFlagRuntime({
      version: async () => "1",
      load: async () => {
        loads += 1;
        return [ON];
      },
    });

    const route = requireFlag("newEditor", { runtime, viewer: () => MEMBER });
    await route(new Request("http://bulletin.localhost/api/editor"), () => new Response("ok"));

    expect(loads).toBe(1);
  });

  test("allows a custom denial response", async () => {
    const runtime = runtimeFor([OFF]);
    const route = requireFlag(
      "newEditor",
      { runtime, viewer: () => MEMBER },
      { onDenied: () => new Response("hidden", { status: 410 }) },
    );

    const response = await route(
      new Request("http://bulletin.localhost/api/editor"),
      () => new Response("ok"),
    );

    expect(response.status).toBe(410);
  });
});
