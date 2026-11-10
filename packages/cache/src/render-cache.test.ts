import { describe, expect, test } from "bun:test";
import { createRenderCache, type RenderRequest } from "./render-cache.ts";
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

/** A request with a fixed key and no view-model data. */
function fixed<T = undefined>(
  key: string,
  tags: readonly string[],
  render: (data: T) => string | Promise<string>,
): RenderRequest<T> {
  return {
    tags,
    prepare: async () => ({ key, data: undefined as T }),
    render,
  };
}

describe("render cache", () => {
  test("renders once per variant and hits while its tags are unchanged", async () => {
    const tags = tagSource({ "forum:2": "1" });
    const cache = createRenderCache({ tags: tags.source });
    let renders = 0;
    const request = fixed("variant-a", ["forum:2"], () => {
      renders += 1;
      return "<p>page</p>";
    });

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
    const request = fixed("variant-a", ["forum:2"], () => {
      renders += 1;
      return `render ${renders}`;
    });

    expect((await cache.getOrRender(request)).status).toBe("miss");
    tags.bump("forum:2");
    expect(await cache.getOrRender(request)).toMatchObject({ status: "miss", html: "render 2" });
  });

  test("reloads the view model when a tag moves while it is prepared", async () => {
    const tags = tagSource({ board: "1" });
    const cache = createRenderCache({ tags: tags.source });
    let prepares = 0;
    let renders = 0;

    const result = await cache.getOrRender<{ version: string }>({
      tags: ["board"],
      prepare: async () => {
        prepares += 1;
        const version = tags.versions.get("board") ?? "0";

        // The first attempt reads the old value, then a settings save and its invalidation
        // commit before the HTML is built.
        if (prepares === 1) {
          tags.bump("board");
        }

        return { key: "home", data: { version } };
      },
      render: (data) => {
        renders += 1;
        return `html at ${data.version}`;
      },
    });

    // The first render predates the invalidation, so it is discarded and prepared again.
    expect(prepares).toBe(2);
    expect(renders).toBe(2);
    expect(result.status).toBe("miss");
    expect(result.html).toBe("html at 2");
    expect(result.versions.get("board")).toBe("2");

    // The stored entry is the fresh one, never the stale first render.
    const second = await cache.getOrRender<{ version: string }>({
      tags: ["board"],
      prepare: async () => ({
        key: "home",
        data: { version: tags.versions.get("board") ?? "0" },
      }),
      render: (data) => `html at ${data.version}`,
    });

    expect(second.status).toBe("hit");
    expect(second.html).toBe("html at 2");
  });

  test("retries with the key the new data produces", async () => {
    const tags = tagSource({ perm: "1" });
    const cache = createRenderCache({ tags: tags.source });
    let prepares = 0;

    const result = await cache.getOrRender<{ key: string }>({
      tags: ["perm"],
      prepare: async () => {
        prepares += 1;

        if (prepares === 1) {
          tags.bump("perm");
          return { key: "key-old", data: { key: "key-old" } };
        }

        return { key: "key-new", data: { key: "key-new" } };
      },
      render: (data) => `html for ${data.key}`,
    });

    expect(result.key).toBe("key-new");
    expect(result.html).toBe("html for key-new");

    const stored = await cache.getOrRender<{ key: string }>({
      tags: ["perm"],
      prepare: async () => ({ key: "key-new", data: { key: "key-new" } }),
      render: (data) => `html for ${data.key}`,
    });

    expect(stored.status).toBe("hit");
    expect(stored.html).toBe("html for key-new");
  });

  test("serves the latest render without storing when the tags never settle", async () => {
    const tags = tagSource({ board: "1" });
    const cache = createRenderCache({ tags: tags.source });

    const result = await cache.getOrRender({
      tags: ["board"],
      prepare: async () => {
        tags.bump("board");
        return { key: "home", data: undefined };
      },
      render: () => "html",
    });

    expect(result.status).toBe("miss");
    expect(cache.size).toBe(0);
  });

  test("returns versions captured before the data is loaded", async () => {
    const tags = tagSource({ "forum:2": "1" });
    const cache = createRenderCache({ tags: tags.source });
    const seen: string[] = [];

    const first = await cache.getOrRender({
      tags: ["forum:2"],
      prepare: async () => {
        seen.push(tags.versions.get("forum:2") ?? "0");
        return { key: "variant-a", data: undefined };
      },
      render: () => "html",
    });

    expect(first.versions.get("forum:2")).toBe("1");
    expect(seen).toEqual(["1"]);

    tags.bump("forum:2");

    // A later request prepares again and stores under the new version.
    await cache.getOrRender({
      tags: ["forum:2"],
      prepare: async () => {
        seen.push(tags.versions.get("forum:2") ?? "0");
        return { key: "variant-a", data: undefined };
      },
      render: () => "html",
    });

    expect(seen).toEqual(["1", "2"]);
  });

  test("ignores tags the fragment did not declare", async () => {
    const tags = tagSource({ "forum:2": "1", "topic:9": "1" });
    const cache = createRenderCache({ tags: tags.source });
    const request = fixed("variant-a", ["forum:2"], () => "html");

    await cache.getOrRender(request);
    tags.bump("topic:9");

    expect((await cache.getOrRender(request)).status).toBe("hit");
  });

  test("separates variants by key", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });

    expect((await cache.getOrRender(fixed("a", [], () => "A"))).status).toBe("miss");
    expect((await cache.getOrRender(fixed("b", [], () => "B"))).status).toBe("miss");
    expect(await cache.getOrRender(fixed("b", [], () => "B"))).toMatchObject({
      status: "hit",
      html: "B",
    });
  });

  test("bypasses the cache while the listener is untrusted and stores nothing", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });
    let renders = 0;
    const request = fixed("variant-a", [], () => {
      renders += 1;
      return `render ${renders}`;
    });

    tags.setTrusted(false);
    expect(await cache.getOrRender(request)).toMatchObject({ status: "bypass", html: "render 1" });
    expect(await cache.getOrRender(request)).toMatchObject({ status: "bypass", html: "render 2" });
    expect(cache.bypasses).toBe(2);
    expect(cache.size).toBe(0);

    tags.setTrusted(true);
    expect((await cache.getOrRender(request)).status).toBe("miss");
    expect((await cache.getOrRender(request)).status).toBe("hit");
  });

  test("bypasses a warmed entry when the listener is lost during prepare", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });

    expect(await cache.getOrRender(fixed("variant-a", [], () => "cached"))).toMatchObject({
      status: "miss",
      html: "cached",
    });

    const result = await cache.getOrRender({
      tags: [],
      prepare: async () => {
        tags.setTrusted(false);
        return { key: "variant-a", data: undefined };
      },
      render: () => "fresh",
    });

    expect(result).toMatchObject({ status: "bypass", html: "fresh" });
    expect(cache.hits).toBe(0);
    expect(cache.bypasses).toBe(1);
  });

  test("does not store HTML rendered after the listener is lost", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });

    const result = await cache.getOrRender({
      tags: [],
      prepare: async () => ({ key: "variant-a", data: undefined }),
      render: () => {
        tags.setTrusted(false);
        return "untrusted render";
      },
    });

    expect(result).toMatchObject({ status: "bypass", html: "untrusted render" });
    expect(cache.size).toBe(0);
    expect(cache.bypasses).toBe(1);
  });

  test("does not serve warmed HTML when a tag moves during prepare", async () => {
    const tags = tagSource({ board: "1" });
    const cache = createRenderCache({ tags: tags.source });

    expect(await cache.getOrRender(fixed("home", ["board"], () => "cached"))).toMatchObject({
      status: "miss",
      html: "cached",
    });

    let prepares = 0;

    const result = await cache.getOrRender({
      tags: ["board"],
      prepare: async () => {
        prepares += 1;

        if (prepares === 1) {
          tags.bump("board");
        }

        return { key: "home", data: undefined };
      },
      render: () => "fresh",
    });

    expect(result).toMatchObject({ status: "miss", html: "fresh" });
    expect(result.versions.get("board")).toBe("2");
    expect(cache.hits).toBe(0);
  });

  test("awaits the perm backstop before trusting versions", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });

    await cache.getOrRender(fixed("a", [], () => "A"));

    // Once before the lookup, once after prepare and once after render (trust is rechecked
    // after every await so a lost listener fails closed).
    expect(tags.permChecks).toBe(3);
  });

  test("fails closed when the perm backstop cannot reach Postgres", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });
    tags.failPermBackstop(true);

    expect((await cache.getOrRender(fixed("a", [], () => "A"))).status).toBe("bypass");
  });

  test("evicts the least recently used fragment over the byte budget", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source, maxBytes: 6 });

    await cache.getOrRender(fixed("a", [], () => "aaa"));
    await cache.getOrRender(fixed("b", [], () => "bbb"));
    await cache.getOrRender(fixed("a", [], () => "unused"));
    await cache.getOrRender(fixed("c", [], () => "ccc"));

    expect(await cache.getOrRender(fixed("b", [], () => "bbb"))).toMatchObject({
      status: "miss",
    });
    expect(cache.size).toBe(2);
  });
});
