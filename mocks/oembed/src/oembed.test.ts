import { afterEach, describe, expect, test } from "bun:test";
import { createOembedHandler, type OembedHandlerOptions } from "./app.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function start(options?: OembedHandlerOptions): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createOembedHandler(options),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

describe("oEmbed mock", () => {
  test("serves a canned oEmbed response", async () => {
    const base = start();
    const response = await fetch(
      `${base}/oembed?url=${encodeURIComponent("https://example.test/article")}`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { title?: string; type?: string; html?: string };
    expect(body.type).toBe("rich");
    expect(body.title).toContain("example.test");
    expect(body.html).toContain("https://example.test/article");
  });

  test("derives provider_url from the configured public origin", async () => {
    const base = start({ providerUrl: "http://bulletin.localhost:18080" });
    const response = await fetch(
      `${base}/oembed?url=${encodeURIComponent("https://example.test/article")}`,
    );
    const body = (await response.json()) as { provider_url?: string };

    expect(body.provider_url).toBe("http://bulletin.localhost:18080");
  });

  test("defaults provider_url to the documented stack", async () => {
    const base = start();
    const response = await fetch(
      `${base}/oembed?url=${encodeURIComponent("https://example.test/article")}`,
    );
    const body = (await response.json()) as { provider_url?: string };

    expect(body.provider_url).toBe("http://bulletin.localhost:8080");
  });

  test("serves OpenGraph HTML", async () => {
    const base = start();
    const response = await fetch(
      `${base}/page?url=${encodeURIComponent("https://example.test/article")}`,
    );
    const html = await response.text();

    expect(html).toContain('property="og:title"');
    expect(html).toContain("Mock link preview for example.test");
    expect(html).toContain("application/json+oembed");
  });

  test("rejects a missing url", async () => {
    const base = start();

    expect((await fetch(`${base}/oembed`)).status).toBe(400);
    expect((await fetch(`${base}/page`)).status).toBe(400);
  });
});
