import type { Root } from "hast";
import { visit } from "unist-util-visit";

/** External links never leak referrers or opening windows (ADR 0007). */
export function addLinkRel(tree: Root): void {
  visit(tree, "element", (node) => {
    if (node.tagName === "a") {
      node.properties.rel = ["nofollow", "ugc", "noopener"];
    }
  });
}
