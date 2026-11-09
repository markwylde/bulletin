import { displayNameSkeleton } from "@bulletin/domain/member";
import type { SeedModule } from "./framework.ts";

export interface SeededProfile {
  readonly sub: string;
  readonly name: string;
  readonly skeleton: string;
  readonly email: string;
  readonly locale: "en" | "es" | "fr";
  /** Primary group key; Members is added as a secondary group when this is not Members. */
  readonly group: "members" | "super_moderators" | "administrators" | "banned";
}

/**
 * Every local identity profile. The subjects and emails must match the identity provider's
 * local configuration; skeletons are computed from the UTS #39 dataset.
 */
const PROFILE_INPUTS: readonly Omit<SeededProfile, "skeleton">[] = [
  {
    sub: "admin",
    name: "Admin",
    email: "admin@bulletin.test",
    locale: "en",
    group: "administrators",
  },
  {
    sub: "super-mod",
    name: "Super Moderator",
    email: "super-mod@bulletin.test",
    locale: "en",
    group: "super_moderators",
  },
  {
    sub: "forum-mod",
    name: "Forum Moderator",
    email: "forum-mod@bulletin.test",
    locale: "en",
    group: "members",
  },
  {
    sub: "member-mod",
    name: "Member Moderator",
    email: "member-mod@bulletin.test",
    locale: "en",
    group: "members",
  },
  {
    sub: "member-1",
    name: "Regular Member One",
    email: "member-1@bulletin.test",
    locale: "en",
    group: "members",
  },
  {
    sub: "member-2",
    name: "Regular Member Two",
    email: "member-2@bulletin.test",
    locale: "en",
    group: "members",
  },
  {
    sub: "new-member",
    name: "New Member",
    email: "new-member@bulletin.test",
    locale: "en",
    group: "members",
  },
  {
    sub: "banned-member",
    name: "Banned Member",
    email: "banned-member@bulletin.test",
    locale: "en",
    group: "banned",
  },
  {
    sub: "warned-member",
    name: "Warned Member",
    email: "warned-member@bulletin.test",
    locale: "en",
    group: "members",
  },
  {
    sub: "member-es",
    name: "Miembro Español",
    email: "member-es@bulletin.test",
    locale: "es",
    group: "members",
  },
  {
    sub: "member-fr",
    name: "Membre Français",
    email: "member-fr@bulletin.test",
    locale: "fr",
    group: "members",
  },
];

export const SEEDED_PROFILES: readonly SeededProfile[] = PROFILE_INPUTS.map((profile) => ({
  ...profile,
  skeleton: displayNameSkeleton(profile.name),
}));

const AUTH_ISSUER = (
  Bun.env.BULLETIN_AUTH_ISSUER ??
  `http://auth.bulletin.localhost:${Bun.env.BULLETIN_HTTP_PORT ?? "8080"}`
).replace(/\/+$/, "");

/**
 * Seeds one member per DarkAuth mock profile, the matching `(issuer, sub)` identity, the
 * member's groups, and a name history for member-1. Task 6.2 verifies each profile logs in.
 */
export const membersSeedModule: SeedModule = {
  name: "members",
  dependsOn: ["base"],
  async run({ sql }) {
    const memberIds = new Map<string, string>();

    for (const profile of SEEDED_PROFILES) {
      const [member] = (await sql`
        INSERT INTO core.members (display_name, name_skeleton, locale)
        VALUES (${profile.name}, ${profile.skeleton}, ${profile.locale})
        ON CONFLICT DO NOTHING
        RETURNING id
      `) as Array<{ id: string }>;

      const memberId =
        member?.id ??
        (
          (await sql`
          SELECT id FROM core.members
          WHERE lower(display_name) = lower(${profile.name}) OR name_skeleton = ${profile.skeleton}
          LIMIT 1
        `) as Array<{ id: string }>
        )[0]?.id;

      if (memberId === undefined) {
        throw new Error(`Could not seed member ${profile.sub}`);
      }

      memberIds.set(profile.sub, memberId);

      await sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        SELECT ${memberId}, g.id, g.key = ${profile.group}
        FROM core.groups g
        WHERE g.key IN ('members', ${profile.group})
        ON CONFLICT DO NOTHING
      `;

      await sql`
        INSERT INTO pii.identities (member_id, issuer, sub, email, idp_name)
        VALUES (${memberId}, ${AUTH_ISSUER}, ${profile.sub}, ${profile.email}, ${profile.name})
        ON CONFLICT (issuer, sub) DO NOTHING
      `;
    }

    const memberOne = memberIds.get("member-1");

    if (memberOne !== undefined) {
      await sql`
        INSERT INTO core.member_name_history (
          member_id, old_name, new_name, changed_at, changed_by
        )
        SELECT ${memberOne}, 'Regular Member', 'Regular Member One',
               now() - interval '60 days', ${memberOne}
        WHERE NOT EXISTS (
          SELECT 1 FROM core.member_name_history WHERE member_id = ${memberOne}
        )
      `;
    }
  },
};
