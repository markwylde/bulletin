import { describe, expect, test } from "bun:test";
import { createRenderCache } from "./render-cache.ts";
import type { TagVersionSource } from "./tags.ts";

function tagSource(initial: Record<string, string> = {}) {
  const versions = new Map(Object.entries(initial));
  let trusted = true;
  let permChecks = 0;
  let permFails = false;

  const source: TagVersionSource = {
    version: (tag) => versions.get(tag) ?? "0",
    isTrusted: () => trusted,
    async ensurePermFresh() {
      permChecks += 1;

      if (permFails) {
        throw new Error("postgres is down");
      }
    },
  };

  return {
    source,
    versions,
    bump(tag: string) {
      versions.set(tag, String(Number(versions.get(tag) ?? "0") + 1));
    },
    setTrusted(value: boolean) {
      trusted = value;
    },
    failPermBackstop(value: boolean) {
      permFails = value;
    },
    get permChecks() {
      return permChecks;
    },
  };
}

describe("render cache", () => {
  test("renders once per variant and hits while its tags are unchanged", async () => {
    const tags = tagSource({ "forum:2": "1" });
    const cache = createRenderCache({ tags: tags.source });
    let renders = 0;
    const render = () => {
      renders += 1;
      return "<p>page</p>";
    };
    const request = { key: "variant-a", tags: ["forum:2"], render };

    expect(await cache.getOrRender(request)).toMatchObject({ status: "miss", html: "<p>page</p>" });
    expect(await cache.getOrRender(request)).toMatchObject({ status: "hit", html: "<p>page</p>" });
    expect(renders).toBe(1);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
    expect(cache.bypasses).toBe(0);
  });

  test("misses when a declared tag is bumped", async () => {
    const tags = tagSource({ "forum:2": "1" });
    const cache = createRenderCache({ tags: tags.source });
    let renders = 0;
    const request = {
      key: "variant-a",
      tags: ["forum:2"],
      render: () => {
        renders += 1;
        return `render ${renders}`;
      },
    };

    expect((await cache.getOrRender(request)).status).toBe("miss");
    tags.bump("forum:2");
    expect(await cache.getOrRender(request)).toMatchObject({ status: "miss", html: "render 2" });
  });

  test("ignores tags the fragment did not declare", async () => {
    const tags = tagSource({ "forum:2": "1", "topic:9": "1" });
    const cache = createRenderCache({ tags: tags.source });
    const request = { key: "variant-a", tags: ["forum:2"], render: () => "html" };

    await cache.getOrRender(request);
    tags.bump("topic:9");

    expect((await cache.getOrRender(request)).status).toBe("hit");
  });

  test("separates variants by key", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });

    expect((await cache.getOrRender({ key: "a", tags: [], render: () => "A" })).status).toBe(
      "miss",
    );
    expect((await cache.getOrRender({ key: "b", tags: [], render: () => "B" })).status).toBe(
      "miss",
    );
    expect(await cache.getOrRender({ key: "b", tags: [], render: () => "B" })).toMatchObject({
      status: "hit",
      html: "B",
    });
  });

  test("bypasses the cache while the listener is untrusted and stores nothing", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });
    let renders = 0;
    const request = {
      key: "variant-a",
      tags: [],
      render: () => {
        renders += 1;
        return `render ${renders}`;
      },
    };

    tags.setTrusted(false);
    expect(await cache.getOrRender(request)).toMatchObject({ status: "bypass", html: "render 1" });
    expect(await cache.getOrRender(request)).toMatchObject({ status: "bypass", html: "render 2" });
    expect(cache.bypasses).toBe(2);
    expect(cache.size).toBe(0);

    tags.setTrusted(true);
    expect((await cache.getOrRender(request)).status).toBe("miss");
    expect((await cache.getOrRender(request)).status).toBe("hit");
  });

  test("awaits the perm backstop before trusting versions", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });

    await cache.getOrRender({ key: "a", tags: [], render: () => "A" });

    expect(tags.permChecks).toBe(1);
  });

  test("fails closed when the perm backstop cannot reach Postgres", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });
    tags.failPermBackstop(true);

    expect((await cache.getOrRender({ key: "a", tags: [], render: () => "A" })).status).toBe(
      "bypass",
    );
  });

  test("evicts the least recently used fragment over the byte budget", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source, maxBytes: 6 });

    await cache.getOrRender({ key: "a", tags: [], render: () => "aaa" });
    await cache.getOrRender({ key: "b", tags: [], render: () => "bbb" });
    await cache.getOrRender({ key: "a", tags: [], render: () => "unused" });
    await cache.getOrRender({ key: "c", tags: [], render: () => "ccc" });

    expect(await cache.getOrRender({ key: "b", tags: [], render: () => "bbb" })).toMatchObject({
      status: "miss",
    });
    expect(cache.size).toBe(2);
  });
});
