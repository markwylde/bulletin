import { describe, expect, test } from "bun:test";
import { createCdnPurger } from "./purge.ts";

describe("CDN purger", () => {
  test("posts the surrogate keys and reports success", async () => {
    const calls: Array<{ url: string; keys: string[] }> = [];
    const purger = createCdnPurger({
      url: "http://cdn/purge",
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          keys: (JSON.parse(String(init?.body)) as { keys: string[] }).keys,
        });
        return new Response("{}", { status: 200 });
      },
    });

    expect(await purger.purge(["forum:2", "topic:201:pages"])).toEqual({
      tags: ["forum:2", "topic:201:pages"],
      ok: true,
    });
    expect(calls).toEqual([{ url: "http://cdn/purge", keys: ["forum:2", "topic:201:pages"] }]);
  });

  test("reports a non-2xx answer as a failure", async () => {
    const purger = createCdnPurger({
      url: "http://cdn/purge",
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });

    expect((await purger.purge(["forum:2"])).ok).toBe(false);
  });

  test("reports a timeout or network error as a failure instead of throwing", async () => {
    const purger = createCdnPurger({
      url: "http://cdn/purge",
      timeoutMs: 20,
      fetchImpl: async (_input, init) => {
        await Bun.sleep(100);

        if (init?.signal?.aborted === true) {
          throw new DOMException("aborted", "AbortError");
        }

        return new Response(null, { status: 204 });
      },
    });

    expect((await purger.purge(["forum:2"])).ok).toBe(false);
  });

  test("does not call the CDN for an empty tag list", async () => {
    let called = false;
    const purger = createCdnPurger({
      url: "http://cdn/purge",
      fetchImpl: async () => {
        called = true;
        return new Response(null, { status: 204 });
      },
    });

    expect(await purger.purge([])).toEqual({ tags: [], ok: true });
    expect(called).toBe(false);
  });
});
