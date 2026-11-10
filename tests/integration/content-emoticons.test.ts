import { describe, expect, test } from "bun:test";
import {
  listEditorEmoticons,
  listEmoticonSets,
  saveEmoticon,
  saveEmoticonSet,
} from "@bulletin/domain/content";
import type { StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { mutateEmoticon } from "../../apps/staff-api/src/emoticons.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function fakeStorage(): StorageClient & { readonly puts: string[]; readonly deletes: string[] } {
  const puts: string[] = [];
  const deletes: string[] = [];

  return {
    puts,
    deletes,
    async put(key) {
      puts.push(key);
      return 1;
    },
    async get() {
      return new Uint8Array();
    },
    async delete(key) {
      deletes.push(key);
    },
    presignGet: () => "https://files.test/get",
    presignPut: () => "https://files.test/put",
  };
}

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_emoticons" }, run);
}

async function createMember(database: TestDatabase, name: string): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${name.toLowerCase().replace(/\s+/g, "")})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error("Could not create member");
  }

  return member.id;
}

integrationDescribe("emoticon management", () => {
  test("rejects a duplicate code and hides non-visible sets from the editor", async () => {
    await withDb(async (database) => {
      const set = await saveEmoticonSet(database.sql, {
        key: "default",
        title: "Default",
        position: 0,
        editorVisible: true,
      });

      if (!set.ok || set.id === undefined) {
        throw new Error("Could not create set");
      }

      const first = await saveEmoticon(database.sql, {
        setId: set.id,
        code: "smile",
        alt: "Smile",
        storageKey: "emoticon/one",
        contentType: "image/png",
        position: 0,
      });
      expect(first.ok).toBe(true);

      expect(
        await saveEmoticon(database.sql, {
          setId: set.id,
          code: "smile",
          alt: "Another smile",
          storageKey: "emoticon/two",
          contentType: "image/png",
          position: 1,
        }),
      ).toMatchObject({ ok: false, code: "duplicate_code", fields: ["code"] });

      expect((await listEditorEmoticons(database.sql))[0]?.emoticons[0]).toMatchObject({
        code: "smile",
        alt: "Smile",
        src: expect.stringMatching(/^\/api\/emoticons\/\d+\/image$/),
      });

      await saveEmoticonSet(database.sql, {
        key: "default",
        title: "Default",
        position: 0,
        editorVisible: false,
      });
      expect(await listEditorEmoticons(database.sql)).toEqual([]);
      expect((await listEmoticonSets(database.sql))[0]?.editorVisible).toBe(false);
    });
  });

  test("uploads through the storage client and cleans up a rejected duplicate", async () => {
    await withDb(async (database) => {
      const actor = await createMember(database, "Emoticon Admin");
      const storage = fakeStorage();
      const set = await mutateEmoticon(database.sql, storage, actor, {
        action: "set-save",
        set: { key: "upload", title: "Upload", position: 0, editorVisible: true },
      });
      expect(set.ok).toBe(true);

      const sets = await listEmoticonSets(database.sql);
      const setId = sets[0]?.id;

      if (setId === undefined) {
        throw new Error("Set missing");
      }

      const image = Buffer.from("fake-png").toString("base64");
      const saved = await mutateEmoticon(database.sql, storage, actor, {
        action: "emoticon-save",
        setId,
        code: "wave",
        alt: "Wave",
        position: 0,
        imageBase64: image,
        contentType: "image/png",
      });
      expect(saved).toMatchObject({ ok: true });
      expect(storage.puts).toHaveLength(1);

      const duplicate = await mutateEmoticon(database.sql, storage, actor, {
        action: "emoticon-save",
        setId,
        code: "wave",
        alt: "Wave again",
        position: 1,
        imageBase64: image,
        contentType: "image/png",
      });
      expect(duplicate).toMatchObject({ ok: false, code: "duplicate_code" });
      expect(storage.puts).toHaveLength(2);
      expect(storage.deletes).toHaveLength(1);
    });
  });

  test("rejects an invalid set key", async () => {
    await withDb(async (database) => {
      expect(
        await saveEmoticonSet(database.sql, {
          key: "Bad Key",
          title: "First",
          position: 0,
          editorVisible: true,
        }),
      ).toMatchObject({ ok: false, code: "invalid", fields: ["key"] });
    });
  });
});
