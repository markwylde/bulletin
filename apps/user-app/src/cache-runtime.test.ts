import { describe, expect, test } from "bun:test";
import type { TagVersions } from "@bulletin/cache";
import { createCacheRuntime } from "./cache-runtime.ts";

function fakeVersions(close: () => void = () => undefined): TagVersions {
  return {
    version: () => "0",
    isTrusted: () => true,
    isConnected: () => true,
    refresh: async () => undefined,
    ensurePermFresh: async () => undefined,
    versions: new Map(),
    markDown: () => undefined,
    close: async () => close(),
  };
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }

    await Bun.sleep(5);
  }

  throw new Error("Timed out waiting for the cache runtime");
}

describe("cache runtime", () => {
  test("retries an initially unavailable listener and starts caching once it connects", async () => {
    let attempts = 0;
    const runtime = createCacheRuntime({
      connect: async () => {
        attempts += 1;

        if (attempts < 3) {
          throw new Error("postgres is starting");
        }

        return fakeVersions();
      },
      retryBaseMs: 5,
      retryMaxMs: 20,
    });

    try {
      const first = await runtime.get();

      expect(first.tags).toBeNull();
      expect(
        (await first.cache.getOrRender({ key: "a", tags: [], render: () => "html" })).status,
      ).toBe("bypass");
      // While the backoff runs, requests share the fallback and do not hammer the database.
      expect((await runtime.get()).tags).toBeNull();
      expect(attempts).toBe(1);

      await waitFor(async () => (await runtime.get()).tags !== null);

      const ready = await runtime.get();

      expect(ready.tags).not.toBeNull();
      expect(attempts).toBe(3);
      expect(
        (await ready.cache.getOrRender({ key: "a", tags: [], render: () => "html" })).status,
      ).toBe("miss");
      expect(
        (await ready.cache.getOrRender({ key: "a", tags: [], render: () => "html" })).status,
      ).toBe("hit");
    } finally {
      await runtime.close();
    }
  });

  test("close stops retrying and closes a listener that arrives late", async () => {
    let closed = false;
    const gate: { resolve: ((value: TagVersions) => void) | null } = { resolve: null };
    const pendingConnect = new Promise<TagVersions>((resolve) => {
      gate.resolve = resolve;
    });
    const runtime = createCacheRuntime({
      connect: () => pendingConnect,
      retryBaseMs: 5,
      retryMaxMs: 20,
    });

    const pending = runtime.get();
    await runtime.close();
    gate.resolve?.(
      fakeVersions(() => {
        closed = true;
      }),
    );

    expect((await pending).tags).toBeNull();
    expect(closed).toBe(true);
    // A closed controller never starts another attempt.
    expect((await runtime.get()).tags).toBeNull();
  });
});
