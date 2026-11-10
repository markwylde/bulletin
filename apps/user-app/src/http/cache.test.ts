import { describe, expect, test } from "bun:test";
import {
  applyCacheHeaders,
  type CacheHeaderInput,
  etagFor,
  isNotModified,
  requestHasSession,
} from "./cache.ts";

const base = {
  cdnCacheable: true,
  hasSession: false,
  hasUnlockGrant: false,
  tags: ["forum:2"],
  etag: '"abc"',
  dev: true,
  status: "miss" as const,
  key: "variant-a",
};

function headers(input: Partial<CacheHeaderInput> = {}): Headers {
  const result = new Headers();
  applyCacheHeaders(result, { ...base, ...input });
  return result;
}

describe("cache headers", () => {
  test("a guest without unlock gets the public CDN policy and surrogate keys", () => {
    const result = headers();

    expect(result.get("cache-control")).toBe("public, s-maxage=15, stale-while-revalidate=15");
    expect(result.get("surrogate-key")).toBe("forum:2");
    expect(result.get("etag")).toBe('"abc"');
  });

  test("a session cookie, an unlock grant or a non-cacheable route is private", () => {
    for (const input of [{ hasSession: true }, { hasUnlockGrant: true }, { cdnCacheable: false }]) {
      const result = headers(input);

      expect(result.get("cache-control")).toBe("private, no-store");
      expect(result.get("surrogate-key")).toBeNull();
    }
  });

  test("dev builds expose the in-process status; production builds do not", () => {
    expect(headers().get("x-cache")).toBe("MISS");
    expect(headers().get("x-cache-key")).toBe("variant-a");
    expect(headers({ dev: false }).get("x-cache")).toBeNull();
    expect(headers({ dev: false }).get("x-cache-key")).toBeNull();
  });

  test("no ETag while the listener is untrusted", () => {
    expect(headers({ etag: null }).get("etag")).toBeNull();
  });
});

describe("ETag", () => {
  const versions = new Map([
    ["forum:2", "1"],
    ["flag:1", "2"],
  ]);

  test("is deterministic and order independent", () => {
    const reordered = new Map([
      ["flag:1", "2"],
      ["forum:2", "1"],
    ]);

    expect(etagFor("variant", versions)).toBe(etagFor("variant", reordered));
  });

  test("changes with the variant or any tag version", () => {
    expect(etagFor("variant", versions)).not.toBe(etagFor("other-variant", versions));
    expect(etagFor("variant", versions)).not.toBe(
      etagFor("variant", new Map([...versions, ["forum:2", "2"]])),
    );
  });

  test("matches If-None-Match forms", () => {
    const etag = etagFor("variant", versions);

    expect(isNotModified(etag, etag)).toBe(true);
    expect(isNotModified(`"nope", ${etag}`, etag)).toBe(true);
    expect(isNotModified(`W/${etag}`, etag)).toBe(true);
    expect(isNotModified("*", etag)).toBe(true);
    expect(isNotModified('"nope"', etag)).toBe(false);
    expect(isNotModified(null, etag)).toBe(false);
    expect(isNotModified(etag, null)).toBe(false);
  });
});

describe("requestHasSession", () => {
  test("detects the session cookie, even when it is not a valid session", () => {
    expect(requestHasSession("bl_session=anything", "development")).toBe(true);
    expect(requestHasSession("bp=fr.1.system", "development")).toBe(false);
    expect(requestHasSession(null, "development")).toBe(false);
    expect(requestHasSession("__Host-bl_session=anything", "production")).toBe(true);
  });
});
