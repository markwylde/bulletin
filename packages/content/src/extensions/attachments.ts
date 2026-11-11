import type { Parent, Root } from "mdast";
import { visit } from "unist-util-visit";

interface CustomNode extends Parent {
  readonly type: string;
  data?: Record<string, unknown>;
}

const ATTACHMENT_URL = /^attachment:(\d{1,20})$/;

function placeholder(id: string, inline: boolean): CustomNode {
  return {
    type: "attachmentPlaceholder",
    children: [],
    data: {
      hName: "bl-attachment",
      hProperties: { dataId: id, dataInline: inline ? "true" : "false" },
    },
  };
}

/**
 * Turns `![name](attachment:123)` and `[name](attachment:123)` into a placeholder the post
 * renderer resolves against the attachments linked to that post (ADR 0019). The database is
 * authoritative: an id that is not linked to the post renders as "attachment removed".
 */
export function applyAttachmentLinks(tree: Root): void {
  visit(tree, "image", (node, index, parent) => {
    if (parent === undefined || index === undefined) {
      return;
    }

    const match = ATTACHMENT_URL.exec(node.url);

    if (match?.[1] !== undefined) {
      parent.children.splice(index, 1, placeholder(match[1], true) as never);
    }
  });

  visit(tree, "link", (node, index, parent) => {
    if (parent === undefined || index === undefined) {
      return;
    }

    const match = ATTACHMENT_URL.exec(node.url);

    if (match?.[1] !== undefined) {
      parent.children.splice(index, 1, placeholder(match[1], false) as never);
    }
  });
}
