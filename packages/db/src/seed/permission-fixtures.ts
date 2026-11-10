import type { SeedModule } from "./framework.ts";

/**
 * A minimal forum tree for the permission-matrix and moderator editors until change
 * `forum-structure` lands the real forum seed. Existing forums (from a later seed) are left
 * untouched.
 */
export const permissionFixtureSeedModule: SeedModule = {
  name: "permission-fixtures",
  dependsOn: ["base"],
  async run({ sql }) {
    const existing = (await sql`SELECT 1 FROM core.forums LIMIT 1`) as unknown[];

    if (existing.length > 0) {
      return;
    }

    const [category] = (await sql`
      INSERT INTO core.forums DEFAULT VALUES RETURNING id
    `) as Array<{ id: string }>;

    if (category === undefined) {
      throw new Error("Could not seed the permission fixture category");
    }

    await sql`INSERT INTO core.forums (parent_id) VALUES (${category.id})`;

    const [general] = (await sql`
      INSERT INTO core.forums (parent_id) VALUES (${category.id}) RETURNING id
    `) as Array<{ id: string }>;

    if (general !== undefined) {
      await sql`INSERT INTO core.forums (parent_id) VALUES (${general.id})`;
    }
  },
};
