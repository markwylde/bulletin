import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_ORPHAN_CRON,
  ATTACHMENT_ORPHAN_QUEUE,
  ATTACHMENT_PROCESS_CRON,
  ATTACHMENT_PROCESS_QUEUE,
  ATTACHMENT_RECONCILE_CRON,
  ATTACHMENT_RECONCILE_QUEUE,
  createAttachmentJobs,
} from "@bulletin/db/jobs";
import type { StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import type { PgBoss } from "pg-boss";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const STORAGE: StorageClient = {
  async put() {
    return 0;
  },
  async get() {
    return new Uint8Array();
  },
  async exists() {
    return false;
  },
  async stat() {
    return { size: 0, contentType: "application/octet-stream", etag: "" };
  },
  async delete() {},
  async copy() {},
  async list() {
    return [];
  },
  presignGet() {
    return "";
  },
  presignPut() {
    return "";
  },
};

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "attachment_jobs" }, run);
}

integrationDescribe("attachment jobs", () => {
  test("registers the processing, orphan and reconciliation schedules", async () => {
    await withDb(async (database) => {
      const calls: string[] = [];

      const boss = {
        getQueue: async () => ({}),
        updateQueue: async (name: string) => {
          calls.push(`update:${name}`);
        },
        createQueue: async (name: string) => {
          calls.push(`create:${name}`);
        },
        work: async (name: string) => {
          calls.push(`work:${name}`);
        },
        schedule: async (name: string, cron: string) => {
          calls.push(`schedule:${name}:${cron}`);
        },
        offWork: async (name: string) => {
          calls.push(`off:${name}`);
        },
      } as unknown as PgBoss;

      const jobs = await createAttachmentJobs({
        boss,
        sql: database.sql,
        storage: STORAGE,
      });

      expect(calls).toContain(`work:${ATTACHMENT_PROCESS_QUEUE}`);
      expect(calls).toContain(`schedule:${ATTACHMENT_PROCESS_QUEUE}:${ATTACHMENT_PROCESS_CRON}`);
      expect(calls).toContain(`work:${ATTACHMENT_ORPHAN_QUEUE}`);
      expect(calls).toContain(`schedule:${ATTACHMENT_ORPHAN_QUEUE}:${ATTACHMENT_ORPHAN_CRON}`);
      expect(calls).toContain(`work:${ATTACHMENT_RECONCILE_QUEUE}`);
      expect(calls).toContain(
        `schedule:${ATTACHMENT_RECONCILE_QUEUE}:${ATTACHMENT_RECONCILE_CRON}`,
      );

      await jobs.stop();

      expect(calls).toContain(`off:${ATTACHMENT_PROCESS_QUEUE}`);
      expect(calls).toContain(`off:${ATTACHMENT_ORPHAN_QUEUE}`);
      expect(calls).toContain(`off:${ATTACHMENT_RECONCILE_QUEUE}`);
    });
  });
});
