import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createSessionStore } from "./session-store.ts";

describe("session store LISTEN client (ADR 0003)", () => {
  test("listens on listenSql, never on the query pool", async () => {
    const channels: string[] = [];
    const sql = new Proxy((() => Promise.resolve([])) as unknown as SQL, {
      get(target, property) {
        if (property === "listen") {
          return () => {
            throw new Error("LISTEN went through the query pool");
          };
        }

        return property === "notify" ? async () => undefined : Reflect.get(target, property);
      },
    });
    const listenSql = {
      listen: async (channel: string) => {
        channels.push(channel);
        return { unlisten: async () => undefined };
      },
    } as unknown as SQL;

    const store = await createSessionStore({ sql, listenSql, cacheTtlMs: 0 });

    expect(channels).toContain("session_revoked");
    await store.close();
  });
});
