import { describe, expect, test } from "bun:test";
import { deleteDraft, purgeExpiredDrafts, readDraft, saveDraft } from "@bulletin/domain/content";
import { suggestMembers } from "@bulletin/domain/member";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  draftDeleteResponse,
  draftGetResponse,
  draftSaveResponse,
} from "../../apps/user-api/src/drafts.ts";
import { memberSuggestResponse } from "../../apps/user-api/src/members.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const CONTEXT = "reply:topic:1";

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_drafts" }, run);
}

async function createMember(
  database: TestDatabase,
  name: string,
  service = false,
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton, is_service)
    VALUES (${name}, ${name.toLowerCase().replace(/\s+/g, "")}, ${service})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error("Could not create member");
  }

  return member.id;
}

integrationDescribe("drafts and mention suggestions", () => {
  test("saves, reads, clears and expires a member draft", async () => {
    await withDb(async (database) => {
      const author = await createMember(database, "Draft Author");

      expect(await readDraft(database.sql, author, CONTEXT)).toBeNull();
      expect(await saveDraft(database.sql, author, CONTEXT, "A **draft**")).toMatchObject({
        contextKey: CONTEXT,
        bodyMd: "A **draft**",
      });
      expect((await readDraft(database.sql, author, CONTEXT))?.bodyMd).toBe("A **draft**");

      expect(await saveDraft(database.sql, author, CONTEXT, "   ")).toBeNull();
      expect(await readDraft(database.sql, author, CONTEXT)).toBeNull();

      await saveDraft(database.sql, author, CONTEXT, "old draft");
      await database.sql`
        UPDATE core.drafts SET updated_at = now() - interval '31 days'
        WHERE member_id = ${author}
      `;
      expect(await purgeExpiredDrafts(database.sql)).toBe(1);

      await saveDraft(database.sql, author, CONTEXT, "later");
      await deleteDraft(database.sql, author, CONTEXT);
      expect(await readDraft(database.sql, author, CONTEXT)).toBeNull();
    });
  });

  test("the API rejects invalid contexts and bodies", async () => {
    await withDb(async (database) => {
      const author = await createMember(database, "Api Author");

      const invalidContext = await draftGetResponse(
        database.sql,
        author,
        new URL("http://bulletin.localhost/api/me/drafts?contextKey=bad context"),
      );
      expect(invalidContext.status).toBe(400);

      const invalidBody = await draftSaveResponse(
        database.sql,
        author,
        new Request("http://bulletin.localhost/api/me/drafts", {
          method: "PUT",
          body: JSON.stringify({ contextKey: CONTEXT, bodyMd: 42 }),
        }),
      );
      expect(invalidBody.status).toBe(400);

      const saved = await draftSaveResponse(
        database.sql,
        author,
        new Request("http://bulletin.localhost/api/me/drafts", {
          method: "PUT",
          body: JSON.stringify({ contextKey: CONTEXT, bodyMd: "hello" }),
        }),
      );
      expect(saved.status).toBe(200);

      const loaded = await draftGetResponse(
        database.sql,
        author,
        new URL(`http://bulletin.localhost/api/me/drafts?contextKey=${CONTEXT}`),
      );
      expect(await loaded.json()).toMatchObject({ draft: { bodyMd: "hello" } });

      const deleted = await draftDeleteResponse(
        database.sql,
        author,
        new URL(`http://bulletin.localhost/api/me/drafts?contextKey=${CONTEXT}`),
      );
      expect(deleted.status).toBe(200);
      expect(await readDraft(database.sql, author, CONTEXT)).toBeNull();
    });
  });

  test("suggest returns up to eight prefix matches and never scans wildcards", async () => {
    await withDb(async (database) => {
      for (const name of [
        "Jo One",
        "Jo Two",
        "Jo Three",
        "Jo Four",
        "Jo Five",
        "Jo Six",
        "Jo Seven",
        "Jo Eight",
        "Jo Nine",
        "Alice",
      ]) {
        await createMember(database, name);
      }
      await createMember(database, "Jo Service", true);

      const members = await suggestMembers(database.sql, "jo");
      expect(members).toHaveLength(8);
      expect(members[0]?.displayName.startsWith("Jo")).toBe(true);
      expect(members[0]?.url).toMatch(/^\/profile\/\d+-jo-/);

      expect(await suggestMembers(database.sql, "%")).toEqual([]);
      const response = await memberSuggestResponse(
        database.sql,
        new URL("http://bulletin.localhost/api/members/suggest?q=jo"),
      );
      expect(((await response.json()) as { members: unknown[] }).members).toHaveLength(8);
    });
  });
});
