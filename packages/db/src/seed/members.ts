import type { SeedModule } from "./framework.ts";

/**
 * The Spanish- and French-locale fixtures. Task 6.2 grows this into every seeded identity
 * profile; the skeletons are the precomputed UTS #39 values for these names.
 */
export const membersSeedModule: SeedModule = {
  name: "members",
  dependsOn: ["base"],
  async run({ sql }) {
    await sql`
      INSERT INTO core.members (display_name, name_skeleton, locale)
      VALUES
        ('Miembro Español', 'miembro espanol', 'es'),
        ('Membre Français', 'membre francais', 'fr')
      ON CONFLICT DO NOTHING
    `;

    await sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      SELECT m.id, g.id, true
      FROM core.members m
      JOIN core.groups g ON g.key = 'members'
      WHERE m.display_name IN ('Miembro Español', 'Membre Français')
      ON CONFLICT DO NOTHING
    `;
  },
};
