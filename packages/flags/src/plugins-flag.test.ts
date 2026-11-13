import { describe, expect, test } from "bun:test";
import { pluginsFlag } from "./defaults.ts";
import { requireFlag } from "./middleware.ts";
import { createFlagRuntime } from "./runtime.ts";
import { GUEST_VIEWER } from "./types.ts";

describe("plugins feature flag", () => {
  test("is declared off by default and render-affecting", () => {
    expect(pluginsFlag).toMatchObject({
      key: "plugins",
      defaultValue: false,
      affectsRender: true,
      clientVisible: true,
    });
  });

  test("toggling the flag changes the render hash used as a cache variant", async () => {
    let on = false;
    const runtime = createFlagRuntime(
      {
        version: async () => (on ? "2" : "1"),
        load: async () => [{ ...pluginsFlag, defaultValue: on }],
      },
      { backstopMs: 0 },
    );

    await runtime.ensureFresh();
    const off = runtime.renderFlagsHash(GUEST_VIEWER);
    expect(runtime.isOn(GUEST_VIEWER, "plugins")).toBe(false);

    on = true;
    await runtime.ensureFresh();
    const onHash = runtime.renderFlagsHash(GUEST_VIEWER);
    expect(runtime.isOn(GUEST_VIEWER, "plugins")).toBe(true);
    expect(runtime.clientFlags(GUEST_VIEWER).plugins).toBe(true);
    expect(onHash).not.toBe(off);

    const guard = { runtime, viewer: () => GUEST_VIEWER };
    const denied = await requireFlag("plugins", guard)(new Request("http://board/p/tip-jar"), () =>
      Response.json({ ok: true }),
    );
    expect(denied.status).toBe(200);
  });

  test("plugin routes answer 404 while the flag is off", async () => {
    const runtime = createFlagRuntime(
      {
        version: async () => "1",
        load: async () => [{ ...pluginsFlag, defaultValue: false }],
      },
      { backstopMs: 0 },
    );
    const route = requireFlag("plugins", { runtime, viewer: () => GUEST_VIEWER });
    const response = await route(new Request("http://board/p/tip-jar"), () =>
      Response.json({ ok: true }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found" });
  });
});
