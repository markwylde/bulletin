import { describe, expect, test } from "bun:test";
import { withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

integrationDescribe("board default locale", () => {
  test("defaults to en and accepts only shipped locales", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "i18n_settings" }, async ({ sql }) => {
      await sql`
        INSERT INTO core.board_settings (id, board_name)
        VALUES (1, 'Bulletin')
      `;

      const [initial] = (await sql`
        SELECT default_locale FROM core.board_settings WHERE id = 1
      `) as Array<{ default_locale: string }>;
      expect(initial?.default_locale).toBe("en");

      await sql`
        UPDATE core.board_settings SET default_locale = 'fr' WHERE id = 1
      `;
      const [updated] = (await sql`
        SELECT default_locale FROM core.board_settings WHERE id = 1
      `) as Array<{ default_locale: string }>;
      expect(updated?.default_locale).toBe("fr");

      let error: unknown;
      try {
        await sql`
          UPDATE core.board_settings SET default_locale = 'de' WHERE id = 1
        `;
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("board_settings_default_locale_check");
    });
  }, 15_000);

  test("keeps the existing role grants on the new column", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "i18n_grants" }, async ({ sql }) => {
      const [privileges] = (await sql`
        SELECT
          has_column_privilege('user_app', 'core.board_settings', 'default_locale', 'SELECT') AS user_app_select,
          has_column_privilege('user_app', 'core.board_settings', 'default_locale', 'UPDATE') AS user_app_update,
          has_column_privilege('staff_api', 'core.board_settings', 'default_locale', 'UPDATE') AS staff_api_update
      `) as Array<{
        user_app_select: boolean;
        user_app_update: boolean;
        staff_api_update: boolean;
      }>;

      expect(privileges).toEqual({
        user_app_select: true,
        user_app_update: false,
        staff_api_update: true,
      });
    });
  }, 15_000);
});
