import { afterEach, describe, expect, test } from "bun:test";
import { renderContent, resolveUnfurlPlaceholders } from "@bulletin/content";
import { processUnfurl } from "@bulletin/db/jobs";
import { readUnfurl, readUnfurlPreview, requestUnfurl } from "@bulletin/domain/content";
import { createSafeFetch, type ResolvedAddress, type SafeFetch } from "@bulletin/domain/net";
import { createS3Handler } from "@bulletin/mock-s3/app";
import { createMemoryStore } from "@bulletin/mock-s3/memory";
import { createStorage, type StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import sharp from "sharp";
import { unfurlImageResponse } from "../../apps/user-app/src/unfurl/image.ts";
import { createOembedHandler } from "../../mocks/oembed/src/app.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function serve(fetch: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function localFetch(overrides: Parameters<typeof createSafeFetch>[0] = {}): SafeFetch {
  return createSafeFetch({
    devAllow: ["127.0.0.1"],
    maxBytes: 1024 * 1024,
    timeoutMs: 1_000,
    maxRedirects: 3,
    ...overrides,
  });
}

/** A real storage client over the in-memory S3 mock, for proxied unfurl images. */
function s3Storage(): StorageClient {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createS3Handler({
      store: createMemoryStore(),
      bucket: "bulletin",
      credentials: {
        accessKeyId: "bulletin",
        secretAccessKey: "bulletin-secret",
        region: "us-east-1",
      },
    }),
  });
  servers.push(server);

  return createStorage({
    endpoint: `http://127.0.0.1:${server.port}`,
    publicEndpoint: `http://127.0.0.1:${server.port}`,
    bucket: "bulletin",
    accessKeyId: "bulletin",
    secretAccessKey: "bulletin-secret",
    region: "us-east-1",
  });
}

function resolver(
  map: Record<string, string>,
): (hostname: string) => Promise<readonly ResolvedAddress[]> {
  return async (hostname) => {
    const address = map[hostname];

    if (address === undefined) {
      throw new Error(`Unknown host ${hostname}`);
    }

    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
}

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_unfurls" }, run);
}

integrationDescribe("unfurl worker (ADR 0007, 0016)", () => {
  test("parses the OpenGraph mock into a cached preview card", async () => {
    await withDb(async (database) => {
      const mock = serve(createOembedHandler());
      const pageUrl = `${mock}/page?url=${encodeURIComponent("https://example.test/article")}`;
      const request = await requestUnfurl(database.sql, pageUrl);

      if (request === null) {
        throw new Error("URL did not normalise");
      }

      const result = await processUnfurl(database.sql, request.urlHash, { fetch: localFetch() });

      expect(result.kind).toBe("stored");
      expect(result.kind === "stored" ? result.result : null).toMatchObject({
        kind: "preview",
        preview: {
          kind: "opengraph",
          title: "Mock link preview for example.test",
        },
      });
      expect((await readUnfurlPreview(database.sql, request.urlHash))?.description).toContain(
        "Canned OpenGraph description",
      );

      const content = await renderContent(pageUrl, {
        profile: "post",
        context: { kind: "forum_post", forumId: "1" },
        authorId: "7",
        unfurls: true,
      });
      const html = await resolveUnfurlPlaceholders(content.bodyHtml, {
        load: (hash) => readUnfurlPreview(database.sql, hash),
      });

      expect(html).toContain('class="unfurl-card"');
      expect(html).toContain("Mock link preview for example.test");
      expect(html).toContain("Canned OpenGraph description");
      expect(html).not.toContain("<img");
    });
  });

  test("proxies the preview image and serves it from the files origin", async () => {
    await withDb(async (database) => {
      const jpeg = new Uint8Array(
        await sharp({
          create: { width: 900, height: 600, channels: 3, background: "#336699" },
        })
          .jpeg()
          .withExif({ IFD0: { Copyright: "Bulletin" } })
          .toBuffer(),
      );
      const imageUrl = `${serve(
        () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }),
      )}/og.jpg`;
      const pageUrl = `${serve(
        () =>
          new Response(
            `<html><head><title>Card</title>` +
              `<meta property="og:title" content="Card with an image">` +
              `<meta property="og:image" content="${imageUrl}">` +
              `</head><body>article</body></html>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
      )}/page`;
      const request = await requestUnfurl(database.sql, pageUrl);

      if (request === null) {
        throw new Error("URL did not normalise");
      }

      const storage = s3Storage();
      const result = await processUnfurl(database.sql, request.urlHash, {
        fetch: localFetch(),
        imageFetch: localFetch(),
        storage,
      });

      expect(result.kind).toBe("stored");
      const preview = await readUnfurlPreview(database.sql, request.urlHash);
      expect(preview?.imageProxy).toMatch(/^\/unfurl\/[0-9a-f]{64}$/);

      const hash = preview?.imageProxy?.slice("/unfurl/".length) ?? "";
      expect(await storage.exists(`unfurl/${hash}`)).toBe(true);

      const stored = await sharp(await storage.get(`unfurl/${hash}`)).metadata();
      expect(stored.format).toBe("webp");
      expect(stored.exif).toBeUndefined();

      const content = await renderContent(pageUrl, {
        profile: "post",
        context: { kind: "forum_post", forumId: "1" },
        authorId: "7",
        unfurls: true,
      });
      const html = await resolveUnfurlPlaceholders(content.bodyHtml, {
        load: (urlHash) => readUnfurlPreview(database.sql, urlHash),
      });

      expect(html).toContain(`<img class="unfurl-image" src="${preview?.imageProxy}"`);
      expect(html).not.toContain(imageUrl);

      const response = await unfurlImageResponse(storage, hash);
      expect(response.status).toBe(302);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      const location = response.headers.get("location");

      if (location === null) {
        throw new Error("Missing redirect location");
      }

      const file = await fetch(location);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("image/webp");
      expect(file.headers.get("content-disposition")).toContain("inline;");
    });
  });

  test("uses a fresh cache row without fetching again", async () => {
    await withDb(async (database) => {
      const mock = serve(createOembedHandler());
      const pageUrl = `${mock}/page?url=${encodeURIComponent("https://example.test/article")}`;
      const request = await requestUnfurl(database.sql, pageUrl);

      if (request === null) {
        throw new Error("URL did not normalise");
      }

      await processUnfurl(database.sql, request.urlHash, { fetch: localFetch() });

      const never: SafeFetch = async () => {
        throw new Error("cache miss");
      };
      const second = await processUnfurl(database.sql, request.urlHash, { fetch: never });

      expect(second).toEqual({ kind: "cached" });
    });
  });

  test("refreshes a preview older than seven days", async () => {
    await withDb(async (database) => {
      const mock = serve(createOembedHandler());
      const pageUrl = `${mock}/page?url=${encodeURIComponent("https://example.test/article")}`;
      const request = await requestUnfurl(database.sql, pageUrl);

      if (request === null) {
        throw new Error("URL did not normalise");
      }

      const first = await processUnfurl(database.sql, request.urlHash, { fetch: localFetch() });
      expect(first.kind).toBe("stored");

      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
      await database.sql`
        UPDATE core.unfurls
        SET fetched_at = ${old}, updated_at = ${old}
        WHERE url_hash = ${request.urlHash}
      `;

      let fetches = 0;
      const counting: SafeFetch = (input, init) => {
        fetches += 1;
        return localFetch()(input, init);
      };
      const refreshed = await processUnfurl(database.sql, request.urlHash, { fetch: counting });

      expect(refreshed.kind).toBe("stored");
      expect(fetches).toBe(1);
      expect((await readUnfurl(database.sql, request.urlHash))?.status).toBe("ready");
    });
  });

  test("blocks an internal address before any fetch", async () => {
    await withDb(async (database) => {
      const request = await requestUnfurl(database.sql, "http://internal.test/secret");

      if (request === null) {
        throw new Error("URL did not normalise");
      }

      const fetch = createSafeFetch({
        resolve: resolver({ "internal.test": "10.0.0.5" }),
        maxRedirects: 3,
        maxBytes: 1024 * 1024,
        timeoutMs: 1_000,
      });
      const result = await processUnfurl(database.sql, request.urlHash, { fetch });

      expect(result.kind).toBe("stored");
      expect(result.kind === "stored" ? result.result.kind : null).toBe("blocked");
      expect((await readUnfurl(database.sql, request.urlHash))?.preview).toBeNull();
      expect((await readUnfurl(database.sql, request.urlHash))?.status).toBe("blocked");
    });
  });

  test("re-checks a redirect target and blocks a private address", async () => {
    await withDb(async (database) => {
      const redirect = serve(
        () => new Response(null, { status: 302, headers: { location: "http://internal.test/" } }),
      );
      const request = await requestUnfurl(
        database.sql,
        `http://redirect.test:${new URL(redirect).port}/`,
      );

      if (request === null) {
        throw new Error("URL did not normalise");
      }

      const fetch = createSafeFetch({
        devAllow: ["redirect.test"],
        resolve: resolver({ "redirect.test": "127.0.0.1", "internal.test": "10.0.0.5" }),
        maxRedirects: 3,
        maxBytes: 1024 * 1024,
        timeoutMs: 1_000,
      });
      const result = await processUnfurl(database.sql, request.urlHash, { fetch });

      expect(result.kind === "stored" ? result.result.kind : null).toBe("blocked");
    });
  });

  test("enforces the response size cap", async () => {
    await withDb(async (database) => {
      const page = serve(
        () =>
          new Response("x".repeat(2_048), {
            headers: { "content-type": "text/html" },
          }),
      );
      const request = await requestUnfurl(database.sql, `${page}/big`);

      if (request === null) {
        throw new Error("URL did not normalise");
      }

      const result = await processUnfurl(database.sql, request.urlHash, {
        fetch: localFetch({ maxBytes: 128 }),
      });

      expect(result.kind === "stored" ? result.result : null).toMatchObject({
        kind: "failed",
        code: "body_too_large",
      });
    });
  });

  test("enforces the fetch timeout", async () => {
    await withDb(async (database) => {
      const page = serve(async () => {
        await Bun.sleep(200);
        return new Response("<html><head><title>late</title></head></html>", {
          headers: { "content-type": "text/html" },
        });
      });
      const request = await requestUnfurl(database.sql, `${page}/slow`);

      if (request === null) {
        throw new Error("URL did not normalise");
      }

      const result = await processUnfurl(database.sql, request.urlHash, {
        fetch: localFetch({ timeoutMs: 20 }),
      });

      expect(result.kind === "stored" ? result.result : null).toMatchObject({
        kind: "failed",
        code: "timeout",
      });
    });
  });

  test("parses an oEmbed link when OpenGraph is missing", async () => {
    await withDb(async (database) => {
      const mock = serve(createOembedHandler());
      const page = serve(
        () =>
          new Response(
            `<!doctype html><html><head><title>Fallback</title><link rel="alternate" type="application/json+oembed" href="${mock}/oembed?url=${encodeURIComponent("https://example.test/oembed")}"></head><body></body></html>`,
            { headers: { "content-type": "text/html" } },
          ),
      );
      const request = await requestUnfurl(database.sql, `${page}/page`);

      if (request === null) {
        throw new Error("URL did not normalise");
      }

      const result = await processUnfurl(database.sql, request.urlHash, { fetch: localFetch() });

      expect(result.kind === "stored" ? result.result : null).toMatchObject({
        kind: "preview",
        preview: {
          kind: "oembed",
          title: "Mock embed for example.test",
          provider: "Bulletin OEmbed",
        },
      });
    });
  });
});
