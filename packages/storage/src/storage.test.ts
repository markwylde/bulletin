import { afterEach, describe, expect, test } from "bun:test";
import { createS3Handler } from "@bulletin/mock-s3/app";
import { createMemoryStore } from "@bulletin/mock-s3/memory";
import {
  attachmentKey,
  avatarKey,
  createStorage,
  isManagedKey,
  KEY_PREFIXES,
  opaqueKey,
  processingKey,
  quarantineKey,
  type StorageClient,
  unfurlImageKey,
} from "./index.ts";

const credentials = {
  accessKeyId: "bulletin",
  secretAccessKey: "bulletin-secret",
  region: "us-east-1",
} as const;

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly copySource: string | null;
}

interface Harness {
  readonly storage: StorageClient;
  readonly requests: RecordedRequest[];
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function start(): Harness {
  const requests: RecordedRequest[] = [];
  const handler = createS3Handler({
    store: createMemoryStore(),
    bucket: "bulletin",
    credentials,
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        copySource: request.headers.get("x-amz-copy-source"),
      });
      return handler(request);
    },
  });
  servers.push(server);

  const storage = createStorage({
    endpoint: `http://127.0.0.1:${server.port}`,
    bucket: "bulletin",
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
  });

  return { storage, requests };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("storage client", () => {
  test("puts, gets and deletes an object", async () => {
    const { storage } = start();
    const key = opaqueKey("att");

    await storage.put(key, "hello storage", { contentType: "text/plain" });

    expect(decode(await storage.get(key))).toBe("hello storage");
    expect(await storage.exists(key)).toBe(true);

    await storage.delete(key);

    expect(await storage.exists(key)).toBe(false);
    await expect(storage.get(key)).rejects.toThrow();
  });

  test("reports object stats", async () => {
    const { storage } = start();
    const key = opaqueKey("att");
    await storage.put(key, "12345", { contentType: "text/plain" });

    const stat = await storage.stat(key);

    expect(stat.size).toBe(5);
    expect(stat.contentType).toContain("text/plain");
    expect(stat.etag.length).toBeGreaterThan(0);
  });

  test("lists objects under a prefix", async () => {
    const { storage } = start();
    await storage.put("av/42/one.webp", "a");
    await storage.put("av/42/two.webp", "b");
    await storage.put("att/other", "c");

    const objects = await storage.list("av/42/");

    expect(objects.map((object) => object.key).sort()).toEqual([
      "av/42/one.webp",
      "av/42/two.webp",
    ]);
  });
});

describe("presigned uploads", () => {
  test("uploads through a presigned PUT", async () => {
    const { storage } = start();
    const key = quarantineKey();
    const url = storage.presignPut(key, { contentLength: 15 });

    const response = await fetch(url, {
      method: "PUT",
      body: "presigned body!",
    });

    expect(response.status).toBe(200);
    expect(decode(await storage.get(key))).toBe("presigned body!");
  });

  test("rejects a body whose size differs from the signed content-length", async () => {
    const { storage } = start();
    const key = quarantineKey();
    const url = storage.presignPut(key, { contentLength: 5 });

    const response = await fetch(url, {
      method: "PUT",
      body: "much larger than five bytes",
    });

    expect(response.status).toBe(403);
    expect(await storage.exists(key)).toBe(false);
  });

  test("downloads through a presigned GET with response overrides", async () => {
    const { storage } = start();
    const key = opaqueKey("export");
    await storage.put(key, "download me", { contentType: "text/plain" });

    const url = storage.presignGet(key, {
      responseContentType: "text/plain",
      responseContentDisposition: 'attachment; filename="export.txt"',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("download me");
    expect(url).toContain("response-content-type=text%2Fplain");
    expect(url).toContain("response-content-disposition=attachment");
  });
});

describe("server-side copy", () => {
  test("copies bytes without reading them through the client", async () => {
    const { storage, requests } = start();
    const source = quarantineKey();
    const destination = processingKey("snapshot");
    await storage.put(source, "quarantined bytes");

    await storage.copy(source, destination);
    const duringCopy = requests.slice();
    await storage.delete(source);

    expect(decode(await storage.get(destination))).toBe("quarantined bytes");

    const copyRequests = duringCopy.filter((request) => request.path.endsWith(`/${destination}`));
    expect(copyRequests.map((request) => request.method)).toEqual(["PUT"]);
    expect(copyRequests[0]?.copySource).toBe(`/bulletin/${source}`);
    // A GET of the source would mean the bytes travelled through this process.
    expect(
      duringCopy.filter(
        (request) => request.method === "GET" && request.path.endsWith(`/${source}`),
      ),
    ).toHaveLength(0);
  });

  test("rejects a copy from a missing source", async () => {
    const { storage } = start();

    await expect(storage.copy(quarantineKey(), processingKey("snapshot"))).rejects.toThrow();
  });
});

describe("key conventions", () => {
  test("generates opaque keys with every prefix", () => {
    const keys = KEY_PREFIXES.map((prefix) => opaqueKey(prefix));

    for (const [index, key] of keys.entries()) {
      const prefix = KEY_PREFIXES[index];
      expect(prefix).toBeDefined();
      expect(key.startsWith(`${prefix}/`)).toBe(true);
      expect(key.split("/")).toHaveLength(2);
      expect(isManagedKey(key)).toBe(true);
    }

    expect(new Set(keys).size).toBe(keys.length);
    expect(opaqueKey("theme", "42")).toBe("theme/42");
  });

  test("uses separate quarantine, snapshot and final attachment keys", () => {
    expect(quarantineKey("abc")).toBe("quarantine/abc");
    expect(processingKey("abc")).toBe("processing/abc");
    expect(attachmentKey("abc")).toBe("att/abc");
    expect(isManagedKey(quarantineKey("abc"))).toBe(true);
    expect(isManagedKey(processingKey("abc"))).toBe(true);
  });

  test("builds content-hashed avatar keys for each variant", () => {
    const hash = "a".repeat(64);

    expect(avatarKey("42", hash, "lg")).toBe(`av/42/${hash}-lg.webp`);
    expect(avatarKey("42", hash, "sm")).toBe(`av/42/${hash}-sm.webp`);
    expect(unfurlImageKey(hash)).toBe(`unfurl/${hash}`);
    expect(() => avatarKey("42", "not-a-hash", "lg")).toThrow();
  });

  test("refuses key segments that could escape their prefix", () => {
    expect(() => quarantineKey("../etc/passwd")).toThrow();
    expect(() => attachmentKey("a/b")).toThrow();
  });
});
