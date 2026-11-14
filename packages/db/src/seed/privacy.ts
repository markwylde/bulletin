import { saveContent } from "@bulletin/content";
import { strToU8, zipSync } from "fflate";
import type { SeedModule } from "./framework.ts";

const SEED_EXPORT_KEY = "export/seed-member-1.zip";

const POLICY_MARKDOWN = `# Privacy policy

This community processes personal data to run the forum and to meet its legal obligations.

## What we keep

- Account identity and email: while your account exists.
- Login and post IP records: 90 days by default.
- Session metadata: 30 days by default.
- Revoked sessions: 7 days by default.
- Restricted-data access log: 2 years.
- Export archives: 7 days.
- IP bans: until they expire.

## Your rights

You can download a copy of your data or request erasure from your account privacy page.
Erasure removes your profile, restricted data, attachments, reactions, follows, friendships,
drafts and notifications. Posts can be kept anonymised or deleted.

## Records kept after erasure

Data requests, the restricted-data access log, moderation records, warnings and an active ban
may be retained on the documented basis in the privacy inventory. Database backups roll over
within 35 days, so erased data disappears from backups as they expire.
`;

/** Local demo data for the privacy screens (task 6.3). */
export const privacySeedModule: SeedModule = {
  name: "privacy",
  dependsOn: ["members"],
  async run({ sql, storage }) {
    const identities = (await sql`
      SELECT sub, member_id::text AS member_id FROM pii.identities
      WHERE sub IN ('admin', 'member-1', 'member-2')
    `) as Array<{ sub: string; member_id: string }>;
    const ids = new Map(identities.map((row) => [row.sub, row.member_id]));
    const admin = ids.get("admin");
    const memberOne = ids.get("member-1");
    const memberTwo = ids.get("member-2");

    if (admin === undefined || memberOne === undefined || memberTwo === undefined) {
      return;
    }

    const archive = zipSync({
      "profile.json": strToU8(
        `${JSON.stringify({ memberId: memberOne, displayName: "Regular Member One" }, null, 2)}\n`,
      ),
      "README.txt": strToU8("Seeded demo export archive.\n"),
    });

    if (storage !== undefined) {
      await storage.put(SEED_EXPORT_KEY, archive, { contentType: "application/zip" });
    }

    await sql`
      INSERT INTO pii.data_requests (
        member_id, kind, status, export_key, export_expires_at, created_at, completed_at
      ) VALUES (
        ${memberOne}, 'export', 'completed', ${SEED_EXPORT_KEY},
        now() + interval '7 days', now() - interval '1 hour', now() - interval '30 minutes'
      )
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO pii.data_requests (member_id, kind, status, created_at, due_at)
      VALUES (
        ${memberTwo}, 'erasure', 'pending',
        now() - interval '26 days', now() + interval '4 days'
      )
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO pii.access_log (
        actor_member_id, subject_member_id, purpose, resource_type, resource_id, created_at
      ) VALUES
        (${admin}, ${memberOne}, 'post_ip', 'post', '1', now() - interval '2 days'),
        (${admin}, ${memberOne}, 'login_ips', 'member', ${memberOne}, now() - interval '1 day'),
        (${admin}, ${memberOne}, 'own_data', 'session', ${memberOne}, now() - interval '3 hours')
    `;

    const policy = await saveContent(POLICY_MARKDOWN, {
      profile: "rules",
      context: { kind: "forum_post", forumId: "0" },
      authorId: admin,
    });
    await sql`
      UPDATE core.privacy_settings
      SET policy_md = ${policy.bodyMd},
          policy_html = ${policy.bodyHtml},
          policy_text = ${policy.bodyText},
          policy_render_version = ${policy.renderVersion},
          policy_sanitiser_version = ${policy.sanitiserVersion},
          policy_updated_at = now()
      WHERE id = 1
    `;
  },
};
