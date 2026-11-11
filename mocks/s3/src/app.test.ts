import { afterEach, describe, expect, test } from "bun:test";
import { createS3Handler } from "./app.ts";
import { createMemoryStore } from "./memory.ts";
import { signRequestHeaders } from "./sigv4.ts";
import type { ObjectStore } from "./types.ts";

const credentials = {
  accessKeyId: "bulletin",
  secretAccessKey: "bulletin-secret",
  region: "us-east-1",
} as const;

function start(store: ObjectStore, basePath?: string) {
  const handler = createS3Handler({
    store,
    bucket: "bulletin",
    credentials,
    ...(basePath === undefined ? {} : { basePath }),
  });
  // The client connects to 127.0.0.1, so bind the fixture to IPv4 as well. The default
  // "localhost" can bind IPv6 and let an ephemeral port collide with another IPv4 listener.
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  const endpoint = `http://127.0.0.1:${server.port}${basePath ?? ""}`;
  const client = new Bun.S3Client({
    endpoint,
    bucket: "bulletin",
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
  });

  return { server, endpoint, client };
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

function serverFor(store: ObjectStore, basePath?: string) {
  const started = start(store, basePath);
  servers.push(started.server);
  return started;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("S3 mock", () => {
  test("round-trips objects through Bun.S3Client", async () => {
    const { client } = serverFor(createMemoryStore());

    await client.write("att/first", "hello", { type: "text/plain" });

    expect(await client.file("att/first").text()).toBe("hello");
    expect(await client.exists("att/first")).toBe(true);
    expect((await client.stat("att/first")).size).toBe(5);

    const list = await client.list({ prefix: "att/" });
    expect(list.contents?.map((object) => object.key)).toEqual(["att/first"]);

    await client.delete("att/first");
    expect(await client.exists("att/first")).toBe(false);
  });

  test("supports presigned PUT and GET", async () => {
    const { client } = serverFor(createMemoryStore());

    const putUrl = client.presign("att/presigned", {
      method: "PUT",
      expiresIn: 60,
      type: "text/plain",
    });
    const put = await fetch(putUrl, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "from presign",
    });

    expect(put.status).toBe(200);
    expect(await client.file("att/presigned").text()).toBe("from presign");

    const getUrl = client.presign("att/presigned", { expiresIn: 60 });
    const get = await fetch(getUrl);

    expect(get.status).toBe(200);
    expect(await get.text()).toBe("from presign");
  });

  test("applies response overrides to presigned GETs", async () => {
    const { client } = serverFor(createMemoryStore());

    await client.write("att/html", "<p>hi</p>", { type: "text/html" });
    const url = client.presign("att/html", {
      expiresIn: 60,
      type: "text/plain",
      contentDisposition: 'attachment; filename="download.txt"',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="download.txt"');
  });

  test("copies an object server-side", async () => {
    const { client } = serverFor(createMemoryStore());

    await client.write("att/source", "copy me");
    const copyUrl = client.presign("att/target", { method: "PUT", expiresIn: 60 });
    const copy = await fetch(copyUrl, {
      method: "PUT",
      headers: { "x-amz-copy-source": "/bulletin/att/source" },
    });

    expect(copy.status).toBe(200);
    expect(await client.file("att/target").text()).toBe("copy me");
  });

  test("rejects unsigned and tampered requests", async () => {
    const { endpoint } = serverFor(createMemoryStore());

    const unsigned = await fetch(`${endpoint}/bulletin/att/nope`);
    expect(unsigned.status).toBe(403);

    const presigned = await fetch(`${endpoint}/bulletin/att/nope?X-Amz-Signature=deadbeef`);
    expect(presigned.status).toBe(403);
  });

  test("rejects stale and future-dated Authorization signatures", async () => {
    const { endpoint } = serverFor(createMemoryStore());
    const url = new URL(`${endpoint}/bulletin/att/freshness`);
    const body = new TextEncoder().encode("freshness body");

    const stale = await fetch(url, {
      method: "PUT",
      headers: signRequestHeaders({
        method: "PUT",
        url,
        body,
        credentials,
        date: new Date("2020-01-01T00:00:00.000Z"),
      }),
      body,
    });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain("expired");

    const future = await fetch(url, {
      method: "PUT",
      headers: signRequestHeaders({
        method: "PUT",
        url,
        body,
        credentials,
        date: new Date(Date.now() + 60 * 60 * 1000),
      }),
      body,
    });
    expect(future.status).toBe(403);
    expect(await future.text()).toContain("future");

    const valid = await fetch(url, {
      method: "PUT",
      headers: signRequestHeaders({ method: "PUT", url, body, credentials }),
      body,
    });
    expect(valid.status).toBe(200);
  });

  test("rejects a valid signature with a tampered concrete payload", async () => {
    const { endpoint } = serverFor(createMemoryStore());
    const url = new URL(`${endpoint}/bulletin/att/signed`);
    const body = new TextEncoder().encode("original body");
    const headers = signRequestHeaders({ method: "PUT", url, body, credentials });

    const accepted = await fetch(url, { method: "PUT", headers, body });
    expect(accepted.status).toBe(200);

    const tampered = await fetch(url, {
      method: "PUT",
      headers,
      body: new TextEncoder().encode("tampered body"),
    });
    expect(tampered.status).toBe(403);

    const stored = await fetch(url, {
      headers: signRequestHeaders({
        method: "GET",
        url,
        body: new Uint8Array(),
        credentials,
      }),
    });
    expect(await stored.text()).toBe("original body");
  });

  test("survives a handler restart with the same store", async () => {
    const store = createMemoryStore();
    const first = serverFor(store);
    await first.client.write("att/durable", "still here");

    const second = serverFor(store);
    expect(await second.client.file("att/durable").text()).toBe("still here");
  });

  test("works behind a Caddy-style path prefix", async () => {
    const { client } = serverFor(createMemoryStore(), "/_mocks/s3");

    await client.write("att/prefixed", "prefixed");
    expect(await client.file("att/prefixed").text()).toBe("prefixed");
  });

  test("exposes a health endpoint and object browser", async () => {
    const { endpoint } = serverFor(createMemoryStore());

    const health = await fetch(`${endpoint}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", objects: 0 });

    const ui = await fetch(`${endpoint}/`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("S3 mock");
  });
});
