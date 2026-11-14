import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { createAttachmentJobs } from "./attachments.ts";
import { createContentJobs } from "./content.ts";
import { createSearchJobs } from "./search.ts";

/**
 * ADR 0003: LISTEN runs on the process's direct connection (`LISTEN_DATABASE_URL`), never on the
 * query pool, which may be a transaction-mode PgBouncer that drops LISTEN state.
 */

function queryPool(): SQL {
  return new Proxy((() => Promise.resolve([])) as unknown as SQL, {
    get(target, property) {
      if (property === "listen") {
        return () => {
          throw new Error("LISTEN went through the query pool");
        };
      }

      return Reflect.get(target, property);
    },
  });
}

function listenClient(channels: string[]): SQL {
  return {
    listen: async (channel: string) => {
      channels.push(channel);
      return { unlisten: async () => undefined };
    },
  } as unknown as SQL;
}

function fakeBoss(): PgBoss {
  return {
    getQueue: async () => ({}),
    createQueue: async () => undefined,
    updateQueue: async () => undefined,
    work: async () => "worker",
    schedule: async () => undefined,
    offWork: async () => undefined,
    send: async () => null,
  } as unknown as PgBoss;
}

describe("worker job listeners use the direct LISTEN client", () => {
  test("content, search and attachment jobs LISTEN on listenSql", async () => {
    const channels: string[] = [];
    const listenSql = listenClient(channels);
    const sql = queryPool();
    const boss = fakeBoss();

    const content = await createContentJobs({ boss, sql, listenSql });
    const search = await createSearchJobs({ boss, sql, listenSql });
    const attachments = await createAttachmentJobs({
      boss,
      sql,
      listenSql,
      storage: {} as never,
    });

    expect(channels).toHaveLength(3);
    await content.stop();
    await search.stop();
    await attachments.stop();
  });
});
