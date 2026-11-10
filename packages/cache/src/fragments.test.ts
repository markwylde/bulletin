import { describe, expect, test } from "bun:test";
import { createFragmentCache, fragmentKey } from "./fragments.ts";

describe("fragmentKey", () => {
  test("is order independent", () => {
    expect(fragmentKey({ theme: "default", plugins: 1 })).toBe(
      fragmentKey({ plugins: 1, theme: "default" }),
    );
  });

  test("separates every variant dimension", () => {
    const base = { route: "/spike/rendering", theme: "default", plugins: 1 };

    expect(fragmentKey(base)).not.toBe(fragmentKey({ ...base, theme: "alt" }));
    expect(fragmentKey(base)).not.toBe(fragmentKey({ ...base, plugins: 2 }));
    expect(fragmentKey(base)).not.toBe(fragmentKey({ ...base, locale: "fr" }));
  });

  test("keeps undefined and the empty string apart", () => {
    expect(fragmentKey({ flag: undefined })).not.toBe(fragmentKey({ flag: "" }));
  });
});

describe("createFragmentCache", () => {
  test("renders once per key and reports the status", async () => {
    const cache = createFragmentCache();
    let renders = 0;
    const render = () => {
      renders += 1;
      return `<p>${renders}</p>`;
    };

    const first = await cache.getOrRender("theme=default", render);
    const second = await cache.getOrRender("theme=default", render);
    const other = await cache.getOrRender("theme=alt", render);

    expect(first).toEqual({ html: "<p>1</p>", status: "miss" });
    expect(second).toEqual({ html: "<p>1</p>", status: "hit" });
    expect(other).toEqual({ html: "<p>2</p>", status: "miss" });
    expect(renders).toBe(2);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(2);
  });

  test("evicts the least recently used fragment when over the byte budget", async () => {
    const cache = createFragmentCache({ maxBytes: 6 });

    await cache.getOrRender("a", () => "aaa");
    await cache.getOrRender("b", () => "bbb");
    // Touch "a" so "b" becomes the eviction candidate.
    await cache.getOrRender("a", () => "unused");
    await cache.getOrRender("c", () => "ccc");

    expect(await cache.getOrRender("a", () => "rerendered")).toEqual({
      html: "aaa",
      status: "hit",
    });
    expect(await cache.getOrRender("b", () => "bbb")).toEqual({ html: "bbb", status: "miss" });
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(6);
  });

  test("supports async renderers", async () => {
    const cache = createFragmentCache();

    const result = await cache.getOrRender("k", () => Promise.resolve("async"));

    expect(result).toEqual({ html: "async", status: "miss" });
  });
});
