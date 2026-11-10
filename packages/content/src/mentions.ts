import type { Element, Root } from "hast";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { MENTION_ATTRIBUTE } from "./types.ts";

/** The marker the write pipeline leaves on every mention anchor (see `types.ts`). */
const MENTION_MARKER = "data-mention";

function isMention(node: Element): boolean {
  const value = node.properties[MENTION_ATTRIBUTE];

  return node.tagName === "a" && typeof value === "string" && /^\d+$/.test(value);
}

/**
 * Viewer gating for stored mention links (ADR 0010). The write pipeline always renders a
 * mention as a profile link; when the viewer's `mentions` flag is off the link is unwrapped to
 * its plain `@name` text before the fragment is cached, so no page can leak a mention link to
 * a viewer the flag excludes.
 */
export async function applyMentionVisibility(html: string, enabled: boolean): Promise<string> {
  if (enabled || !html.includes(MENTION_MARKER)) {
    return html;
  }

  return String(
    await unified()
      .use(rehypeParse, { fragment: true })
      .use(() => (tree: Root) => {
        visit(tree, "element", (node, index, parent) => {
          if (index === undefined || parent === undefined || !isMention(node)) {
            return;
          }

          parent.children.splice(index, 1, ...node.children);
          // Continue with the content that replaced the anchor.
          return [SKIP, index];
        });
      })
      .use(rehypeStringify)
      .process(html),
  );
}
