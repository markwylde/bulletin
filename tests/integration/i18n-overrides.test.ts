import { describe, expect, test } from "bun:test";
import {
  createStringOverrideSource,
  deleteStringOverride,
  readStringOverrideVersion,
  StringOverrideError,
  setStringOverride,
} from "@bulletin/db/i18n";
import { createStringOverrideLayer, stringOverrideTag } from "@bulletin/i18n";
import { withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

integrationDescribe("string overrides", () => {
  test("applies an override and a revert restores the shipped string", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "i18n_overrides" }, async ({ sql }) => {
      const layer = createStringOverrideLayer(createStringOverrideSource(sql));

      expect(await layer.translate("en", "topic.reply.button")).toBe("Reply");
      expect(await readStringOverrideVersion(sql, "en")).toBe("0");

      await setStringOverride(sql, {
        locale: "en",
        key: "topic.reply.button",
        value: "Respond",
        updatedBy: 7n,
      });

      expect(await readStringOverrideVersion(sql, "en")).toBe("1");
      expect(await layer.translate("en", "topic.reply.button")).toBe("Respond");

      await deleteStringOverride(sql, { locale: "en", key: "topic.reply.button" });

      expect(await readStringOverrideVersion(sql, "en")).toBe("2");
      expect(await layer.translate("en", "topic.reply.button")).toBe("Reply");
    });
  }, 15_000);

  test("rejects an override that drops the base placeholder", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "i18n_bad_override" }, async ({ sql }) => {
      let error: unknown;

      try {
        await setStringOverride(sql, {
          locale: "en",
          key: "topic.reply.count",
          value: "Many replies",
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(StringOverrideError);
      expect(String(error)).toContain("missing {count}");

      const rows = (await sql`
        SELECT key FROM core.string_overrides WHERE locale = 'en'
      `) as Array<{ key: string }>;
      expect(rows).toEqual([]);
    });
  }, 15_000);

  test("uses the i18n locale tag and keeps the role grants", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "i18n_override_grants" }, async ({ sql }) => {
      expect(stringOverrideTag("fr")).toBe("i18n:fr");

      const [privileges] = (await sql`
        SELECT
          has_table_privilege('user_app', 'core.string_overrides', 'SELECT') AS user_app_select,
          has_table_privilege('user_app', 'core.string_overrides', 'UPDATE') AS user_app_update,
          has_table_privilege('user_api', 'core.string_overrides', 'SELECT') AS user_api_select,
          has_table_privilege('workers', 'core.string_overrides', 'SELECT') AS workers_select,
          has_table_privilege('staff_api', 'core.string_overrides', 'INSERT') AS staff_api_insert,
          has_table_privilege('staff_api', 'core.string_overrides', 'DELETE') AS staff_api_delete
      `) as Array<Record<string, boolean>>;

      expect(privileges).toEqual({
        user_app_select: true,
        user_app_update: false,
        user_api_select: true,
        workers_select: true,
        staff_api_insert: true,
        staff_api_delete: true,
      });
    });
  }, 15_000);
});
