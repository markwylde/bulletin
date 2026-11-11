import { memberTag, type RenderCache } from "@bulletin/cache";
import { readMemberSignatures } from "@bulletin/domain/profiles";
import type { Locale, Translator } from "@bulletin/i18n";
import { escapeHtml } from "@bulletin/templates";
import type { SQL } from "bun";

/**
 * One cached signature fragment per member (`member:{id}:sig`, task 2.1). The fragment is
 * composed after the post block so editing a signature rebuilds only the fragment; "hide
 * signatures" is applied by the overlay, never in shared HTML (ADR 0006).
 */
export async function renderMemberSignatures(
  sql: SQL,
  cache: RenderCache,
  memberIds: readonly string[],
  locale: Locale,
  translate: Translator,
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(memberIds)];
  const signatures = await readMemberSignatures(sql, unique);
  const rendered = new Map<string, string>();

  await Promise.all(
    unique.map(async (memberId) => {
      const signature = signatures.get(memberId);

      if (signature === undefined || signature.trim() === "") {
        rendered.set(memberId, "");
        return;
      }

      const fragment = await cache.getOrRender({
        tags: [memberTag(memberId)],
        prepare: async () => ({
          key: `member-signature:${memberId}:${locale}`,
          data: signature,
        }),
        render: (html) =>
          [
            `<aside class="bl-post__signature" data-signature="${memberId}" aria-label="${escapeHtml(
              translate("post.signature"),
            )}">`,
            html,
            "</aside>",
          ].join(""),
      });

      rendered.set(memberId, fragment.html);
    }),
  );

  return rendered;
}
