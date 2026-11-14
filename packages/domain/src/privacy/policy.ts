import { saveContent } from "@bulletin/content";
import type { SQL } from "bun";

export interface PrivacyPolicy {
  readonly markdown: string;
  readonly html: string;
  readonly updatedAt: Date | null;
}

export async function readPrivacyPolicy(sql: SQL): Promise<PrivacyPolicy> {
  const rows = (await sql`
    SELECT policy_md, policy_html, policy_updated_at
    FROM core.privacy_settings
    WHERE id = 1
  `) as Array<{
    policy_md: string;
    policy_html: string;
    policy_updated_at: Date | null;
  }>;
  const row = rows[0];

  return {
    markdown: row?.policy_md ?? "",
    html: row?.policy_html ?? "",
    updatedAt: row?.policy_updated_at ?? null,
  };
}

/** Renders the admin's Markdown through the sanitised content pipeline and stores both forms. */
export async function savePrivacyPolicy(
  sql: SQL,
  actorId: string,
  markdown: string,
): Promise<PrivacyPolicy> {
  const rendered = await saveContent(markdown, {
    profile: "rules",
    context: { kind: "forum_post", forumId: "0" },
    authorId: actorId,
  });
  const updatedAt = new Date();

  await sql`
    UPDATE core.privacy_settings
    SET policy_md = ${rendered.bodyMd},
        policy_html = ${rendered.bodyHtml},
        policy_text = ${rendered.bodyText},
        policy_render_version = ${rendered.renderVersion},
        policy_sanitiser_version = ${rendered.sanitiserVersion},
        policy_updated_at = ${updatedAt}
    WHERE id = 1
  `;

  return { markdown: rendered.bodyMd, html: rendered.bodyHtml, updatedAt };
}
