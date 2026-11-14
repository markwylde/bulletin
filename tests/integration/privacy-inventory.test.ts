import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTestDatabase } from "@bulletin/test-utils/database";
import {
  DEFAULT_MIGRATIONS_DIR,
  INVENTORY_PATH,
  readInventory,
  readPersonalComments,
} from "../../scripts/privacy-inventory.ts";

/**
 * The applied database must carry exactly the `@personal` tags in the migrations, and those
 * tags must match the inventory document (ADR 0012; privacy-gdpr task 1.1). The build check
 * compares files; this test catches a migration that never reached `COMMENT ON COLUMN`.
 */

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const root = join(import.meta.dir, "..", "..");

integrationDescribe("personal-data inventory", () => {
  test("the applied comments, migrations and inventory document agree", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "privacy_inventory" }, async ({ sql }) => {
      const rows = (await sql`
        SELECT n.nspname || '.' || c.relname || '.' || a.attname AS column_name,
               d.description
        FROM pg_description d
        JOIN pg_class c ON c.oid = d.objoid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
        WHERE d.description LIKE '@personal%'
        ORDER BY column_name
      `) as Array<{ column_name: string; description: string }>;

      const applied = new Map<string, string>();

      for (const row of rows) {
        const match = /@personal\s+class=([a-z-]+)/.exec(row.description);

        if (match?.[1] !== undefined) {
          applied.set(row.column_name, match[1]);
        }
      }

      const migrations = await readPersonalComments(join(root, DEFAULT_MIGRATIONS_DIR));
      const inventory = await readInventory(join(root, INVENTORY_PATH));

      const sorted = (entries: Map<string, string>) =>
        [...entries].sort(([a], [b]) => a.localeCompare(b));

      expect(sorted(applied)).toEqual(sorted(migrations));
      expect(sorted(inventory)).toEqual(sorted(migrations));
      expect(applied.size).toBeGreaterThan(200);
    });
  }, 60_000);
});
