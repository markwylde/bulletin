import { afterEach, describe, expect, test } from "bun:test";
import { createCdn } from "./app.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function start(options?: { now?: () => number }) {
  let upstreamRequests = 0;
  let releaseSlow: (() => void) | undefined;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      upstreamRequests += 1;
      const url = new URL(request.url);

      if (url.pathname === "/slow") {
        await slowGate;
      }

      if (url.pathname.includes("evil.example")) {
        return new Response(request.headers.get("host") ?? "", {
          headers: { "cache-control": "public, s-maxage=60" },
        });
      }

      if (url.pathname === "/private") {
        return new Response("private", { headers: { "cache-control": "private, max-age=60" } });
      }

      if (url.pathname === "/nocache") {
        return new Response("nocache", { headers: { "cache-control": "no-store" } });
      }

      if (url.pathname === "/must-revalidate") {
        return new Response("must-revalidate", {
          headers: { "cache-control": "no-cache, max-age=60" },
        });
      }

      return new Response(`page ${upstreamRequests}`, {
        headers: {
          "cache-control": "public, s-maxage=60, stale-while-revalidate=60",
          "surrogate-key": "forum:3 topic:9",
          "content-type": "text/html",
        },
      });
    },
  });
  servers.push(upstream);

  const cdn = createCdn({
    origin: `http://127.0.0.1:${upstream.port}`,
    ...options,
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: cdn.handler });
  servers.push(server);

  return {
    cdn,
    base: `http://127.0.0.1:${server.port}`,
    upstreamRequests: () => upstreamRequests,
    releaseSlow: () => releaseSlow?.(),
  };
}

describe("CDN mock", () => {
  test("caches guest responses and keys them by bp", async () => {
    const { base, upstreamRequests } = start();

    const first = await fetch(`${base}/page`, { headers: { cookie: "bp=en.1.light" } });
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(await first.text()).toBe("page 1");

    const second = await fetch(`${base}/page`, { headers: { cookie: "bp=en.1.light" } });
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(await second.text()).toBe("page 1");

    const otherVariant = await fetch(`${base}/page`, { headers: { cookie: "bp=fr.2.dark" } });
    expect(otherVariant.headers.get("x-cache")).toBe("MISS");
    expect(await otherVariant.text()).toBe("page 2");

    expect(upstreamRequests()).toBe(2);
  });

  test("ignores non-bp cookies but does not cache sessions", async () => {
    const { base } = start();

    const unrelated = await fetch(`${base}/page`, { headers: { cookie: "theme=dark" } });
    expect(unrelated.headers.get("x-cache")).toBe("MISS");

    const repeated = await fetch(`${base}/page`, { headers: { cookie: "theme=dark" } });
    expect(repeated.headers.get("x-cache")).toBe("HIT");

    const session = await fetch(`${base}/page`, { headers: { cookie: "__Host-bl_session=abc" } });
    expect(session.headers.get("x-cache")).toBe("BYPASS");
  });

  test("honours private and no-store", async () => {
    const { base } = start();

    expect((await fetch(`${base}/private`)).headers.get("x-cache")).toBe("MISS");
    expect((await fetch(`${base}/private`)).headers.get("x-cache")).toBe("MISS");
    expect((await fetch(`${base}/nocache`)).headers.get("x-cache")).toBe("MISS");
    expect((await fetch(`${base}/nocache`)).headers.get("x-cache")).toBe("MISS");
  });

  test("honours no-cache even with a positive max-age", async () => {
    const { base } = start();

    expect((await fetch(`${base}/must-revalidate`)).headers.get("x-cache")).toBe("MISS");
    expect((await fetch(`${base}/must-revalidate`)).headers.get("x-cache")).toBe("MISS");
  });

  test("purges by surrogate key", async () => {
    const { base, cdn } = start();

    await fetch(`${base}/page`, { headers: { cookie: "bp=en.1.light" } });
    expect(cdn.stats().entries).toBe(1);

    const purge = await fetch(`${base}/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["forum:3"] }),
    });
    expect(await purge.json()).toEqual({ purged: 1, keys: ["forum:3"] });

    const afterPurge = await fetch(`${base}/page`, { headers: { cookie: "bp=en.1.light" } });
    expect(afterPurge.headers.get("x-cache")).toBe("MISS");
  });

  test("a purge during a blocked origin response cannot repopulate the entry", async () => {
    const { base, cdn, releaseSlow } = start();

    const pending = fetch(`${base}/slow`, { headers: { cookie: "bp=en.1.light" } });
    await Bun.sleep(20);

    await fetch(`${base}/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["forum:3"] }),
    });
    releaseSlow();

    expect((await pending).headers.get("x-cache")).toBe("MISS");
    expect(cdn.stats().entries).toBe(0);

    const afterPurge = await fetch(`${base}/slow`, { headers: { cookie: "bp=en.1.light" } });
    expect(afterPurge.headers.get("x-cache")).toBe("MISS");
  });

  test("does not let a double-slash pathname escape the upstream origin", async () => {
    const { base } = start();

    const response = await fetch(`${base}//evil.example/path`);
    const body = await response.text();

    expect(body).not.toContain("evil.example");
    expect(body).toContain("127.0.0.1");
  });

  test("serves stale content within stale-while-revalidate", async () => {
    let clock = 0;
    const { base } = start({ now: () => clock });

    await fetch(`${base}/page`, { headers: { cookie: "bp=en.1.light" } });
    clock = 61_000;

    const stale = await fetch(`${base}/page`, { headers: { cookie: "bp=en.1.light" } });
    expect(stale.headers.get("x-cache")).toBe("STALE");
  });

  test("exposes health, stats and the inspector UI", async () => {
    const { base } = start();

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()) as { status: string }).toMatchObject({ status: "ok" });

    const ui = await fetch(`${base}/__ui`);
    expect(await ui.text()).toContain("CDN mock");
  });
});
