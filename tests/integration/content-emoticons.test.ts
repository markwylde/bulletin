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
import { emoticonImageResponse } from "../../apps/user-api/src/emoticons.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

/** A 1x1 transparent GIF, so the test can prove the upload is re-encoded as PNG. */
const GIF_IMAGE = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function fakeStorage(): StorageClient & {
  readonly puts: string[];
  readonly putBodies: string[];
  readonly putTypes: Array<string | undefined>;
  readonly deletes: string[];
} {
  const puts: string[] = [];
  const putBodies: string[] = [];
  const putTypes: Array<string | undefined> = [];
  const deletes: string[] = [];

  return {
    puts,
    putBodies,
    putTypes,
    deletes,
    async put(key, data, options) {
      puts.push(key);
      putBodies.push(typeof data === "string" ? data : Buffer.from(data).toString("base64"));
      putTypes.push(options?.contentType);
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

      const image = GIF_IMAGE;
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
      expect(storage.putTypes).toEqual(["image/png"]);

      const stored = Buffer.from(storage.putBodies[0] ?? "", "base64");
      expect(stored.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

      const [storedRow] = (await database.sql`
        SELECT content_type FROM core.emoticons WHERE code = 'wave'
      `) as Array<{ content_type: string }>;
      expect(storedRow?.content_type).toBe("image/png");

      const savedId = saved.ok ? saved.id : undefined;

      if (savedId === undefined) {
        throw new Error("Saved emoticon has no id");
      }

      const updated = await mutateEmoticon(database.sql, storage, actor, {
        action: "emoticon-save",
        id: savedId,
        setId,
        code: "wave2",
        alt: "Wave two",
        position: 3,
      });
      expect(updated).toMatchObject({ ok: true, id: savedId });

      const rows = (await database.sql`
        SELECT code, alt, position FROM core.emoticons WHERE id = ${savedId}
      `) as Array<{ code: string; alt: string; position: number }>;
      expect(rows).toEqual([{ code: "wave2", alt: "Wave two", position: 3 }]);

      const duplicate = await mutateEmoticon(database.sql, storage, actor, {
        action: "emoticon-save",
        setId,
        code: "wave2",
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

  test("revalidates a replaced emoticon image instead of caching it for a year", async () => {
    await withDb(async (database) => {
      const set = await saveEmoticonSet(database.sql, {
        key: "revalidate",
        title: "Revalidate",
        position: 0,
        editorVisible: true,
      });

      if (!set.ok || set.id === undefined) {
        throw new Error("Could not create set");
      }

      const saved = await saveEmoticon(database.sql, {
        setId: set.id,
        code: "wave",
        alt: "Wave",
        storageKey: "emoticon/one",
        contentType: "image/png",
        position: 0,
      });
      const id = saved.ok ? saved.id : undefined;

      if (id === undefined) {
        throw new Error("Could not create emoticon");
      }

      const storage = fakeStorage();
      let bytes = new Uint8Array([1, 2, 3]);
      storage.get = async () => bytes;
      const url = `http://localhost/api/emoticons/${id}/image`;

      const first = await emoticonImageResponse(database.sql, storage, id, new Request(url));
      const firstEtag = first.headers.get("etag");

      expect(first.headers.get("cache-control")).not.toContain("immutable");
      expect(first.headers.get("cache-control")).toContain("max-age=0");
      expect(firstEtag).not.toBeNull();
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(bytes);

      // Staff can replace the file behind the same id; the URL does not change.
      expect(
        await saveEmoticon(database.sql, {
          id,
          setId: set.id,
          code: "wave",
          alt: "Wave",
          storageKey: "emoticon/two",
          contentType: "image/png",
          position: 0,
        }),
      ).toMatchObject({ ok: true, id });
      bytes = new Uint8Array([4, 5, 6]);

      const reloaded = await emoticonImageResponse(
        database.sql,
        storage,
        id,
        new Request(url, { headers: { "if-none-match": firstEtag ?? "" } }),
      );
      const nextEtag = reloaded.headers.get("etag");

      expect(reloaded.status).toBe(200);
      expect(new Uint8Array(await reloaded.arrayBuffer())).toEqual(bytes);
      expect(nextEtag).not.toBe(firstEtag);

      const cached = await emoticonImageResponse(
        database.sql,
        storage,
        id,
        new Request(url, { headers: { "if-none-match": nextEtag ?? "" } }),
      );
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");
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
