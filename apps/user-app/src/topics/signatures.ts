import { GLOBAL_CACHE_TAGS, memberTag, type RenderCache } from "@bulletin/cache";
import { applyReplaceWordsToHtml, type ReplaceWords } from "@bulletin/content";
import { readMemberSignatures } from "@bulletin/domain/profiles";
import type { Locale, Translator } from "@bulletin/i18n";
import { escapeHtml } from "@bulletin/templates";
import type { SQL } from "bun";

/**
 * One cached signature fragment per member (`member:{id}:sig`, task 2.1). The signature is
 * loaded inside `prepare` so an edit that lands after the page's tag snapshot is never stored
 * under the newer `member:{id}` version. "Hide signatures" is applied by the overlay, never in
 * shared HTML (ADR 0006).
 */
export async function renderMemberSignatures(
  sql: SQL,
  cache: RenderCache,
  memberIds: readonly string[],
  locale: Locale,
  translate: Translator,
  loadSignature: (memberId: string) => Promise<string | null> = async (memberId) =>
    (await readMemberSignatures(sql, [memberId])).get(memberId) ?? null,
  replaceWords?: ReplaceWords,
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(memberIds)];
  const rendered = new Map<string, string>();
  const label = escapeHtml(translate("post.signature"));

  await Promise.all(
    unique.map(async (memberId) => {
      const fragment = await cache.getOrRender({
        tags: [memberTag(memberId), GLOBAL_CACHE_TAGS.filters],
        prepare: async () => ({
          key: `member-signature:${memberId}:${locale}`,
          data: await applyReplaceWordsToHtml((await loadSignature(memberId)) ?? "", replaceWords),
        }),
        render: (html) =>
          html.trim() === ""
            ? ""
            : [
                `<aside class="bl-post__signature" data-signature="${memberId}" aria-label="${label}">`,
                html,
                "</aside>",
              ].join(""),
      });

      rendered.set(memberId, fragment.html);
    }),
  );

  return rendered;
}
