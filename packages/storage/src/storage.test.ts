import { afterEach, describe, expect, test } from "bun:test";
import { createS3Handler } from "@bulletin/mock-s3/app";
import { createMemoryStore } from "@bulletin/mock-s3/memory";
import { createStorage, KEY_PREFIXES, opaqueKey } from "./index.ts";

const credentials = {
  accessKeyId: "bulletin",
  secretAccessKey: "bulletin-secret",
  region: "us-east-1",
} as const;

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function start() {
  const handler = createS3Handler({
    store: createMemoryStore(),
    bucket: "bulletin",
    credentials,
  });
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);

  const storage = createStorage({
    endpoint: `http://127.0.0.1:${server.port}`,
    bucket: "bulletin",
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
  });

  return storage;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("storage client", () => {
  test("puts, gets and deletes an object", async () => {
    const storage = start();
    const key = opaqueKey("att");

    await storage.put(key, "hello storage", { contentType: "text/plain" });

    expect(decode(await storage.get(key))).toBe("hello storage");

    await storage.delete(key);

    await expect(storage.get(key)).rejects.toThrow();
  });

  test("uploads through a presigned PUT", async () => {
    const storage = start();
    const key = opaqueKey("av");
    const url = storage.presignPut(key, { contentType: "text/plain" });

    const response = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "presigned body",
    });

    expect(response.status).toBe(200);
    expect(decode(await storage.get(key))).toBe("presigned body");
  });

  test("downloads through a presigned GET", async () => {
    const storage = start();
    const key = opaqueKey("export");
    await storage.put(key, "download me");

    const response = await fetch(storage.presignGet(key));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("download me");
  });

  test("generates opaque keys with every prefix", () => {
    const keys = KEY_PREFIXES.map((prefix) => opaqueKey(prefix));

    for (const [index, key] of keys.entries()) {
      const prefix = KEY_PREFIXES[index];
      expect(prefix).toBeDefined();
      expect(key.startsWith(`${prefix}/`)).toBe(true);
      expect(key.split("/")).toHaveLength(2);
    }

    expect(new Set(keys).size).toBe(keys.length);
    expect(opaqueKey("theme", "42")).toBe("theme/42");
  });
});
