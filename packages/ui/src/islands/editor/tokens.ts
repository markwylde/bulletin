import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { $nodeSchema, $remark } from "@milkdown/kit/utils";
import type { EditorEmoticon } from "./types.ts";

interface MarkdownChild {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownChild[];
}

interface MarkdownParent {
  children?: MarkdownChild[];
}

function token(attrs: {
  kind: "mention" | "emoticon" | "spoiler";
  value: string;
  label?: string;
  href?: string;
  src?: string;
  alt?: string;
  code?: string;
}): MarkdownChild {
  return {
    type: "bulletinToken",
    ...attrs,
    children: [],
  } as MarkdownChild;
}

function text(value: string): MarkdownChild {
  return { type: "text", value };
}

export function splitInlineTokens(
  value: string,
  emoticons: ReadonlyMap<string, EditorEmoticon>,
): MarkdownChild[] {
  const pattern = /:([a-z0-9_+-]{1,32}):|\|\|([^|\n]+)\|\|/gi;
  const pieces: MarkdownChild[] = [];
  let cursor = 0;

  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    const code = match[1]?.toLowerCase();
    const emoticon = code === undefined ? undefined : emoticons.get(code);
    const spoiler = match[2];

    if (emoticon === undefined && spoiler === undefined) {
      continue;
    }

    if (start > cursor) {
      pieces.push(text(value.slice(cursor, start)));
    }

    if (emoticon !== undefined) {
      pieces.push(
        token({
          kind: "emoticon",
          value: `:${emoticon.code}:`,
          src: emoticon.src,
          alt: emoticon.alt,
          code: emoticon.code,
        }),
      );
    } else if (spoiler !== undefined) {
      pieces.push(token({ kind: "spoiler", value: `||${spoiler}||`, label: spoiler }));
    }

    cursor = start + match[0].length;
  }

  if (cursor === 0) {
    return [text(value)];
  }

  if (cursor < value.length) {
    pieces.push(text(value.slice(cursor)));
  }

  return pieces;
}

export function transform(
  node: MarkdownParent,
  emoticons: ReadonlyMap<string, EditorEmoticon>,
): void {
  if (node.children === undefined) {
    return;
  }

  const children: MarkdownChild[] = [];

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];

    if (child === undefined) {
      continue;
    }

    if (child.type === "code" || child.type === "inlineCode" || child.type === "link") {
      children.push(child);
      continue;
    }

    if (child.type === "text" && child.value !== undefined) {
      const next = node.children[index + 1];
      const linkId = next?.type === "link" ? /^member:(\d+)$/.exec(next.url ?? "")?.[1] : undefined;

      if (linkId !== undefined && child.value.endsWith("@")) {
        const before = child.value.slice(0, -1);

        if (before !== "") {
          children.push(...splitInlineTokens(before, emoticons));
        }

        const label = (next?.children ?? []).map((part) => part.value ?? "").join("");
        children.push(
          token({
            kind: "mention",
            value: `@[${label}](member:${linkId})`,
            label,
            href: `member:${linkId}`,
          }),
        );
        index += 1;
        continue;
      }

      children.push(...splitInlineTokens(child.value, emoticons));
      continue;
    }

    if (child.children !== undefined) {
      transform(child, emoticons);
    }

    children.push(child);
  }

  node.children = children;
}

export function createBulletinTokenPlugins(emoticons: readonly EditorEmoticon[]) {
  const byCode = new Map(emoticons.map((emoticon) => [emoticon.code.toLowerCase(), emoticon]));
  const remark = $remark(
    "bulletinTokens",
    () => () => (tree: MarkdownParent) => transform(tree, byCode),
  );
  const schema = $nodeSchema("bulletinToken", () => ({
    group: "inline",
    inline: true,
    atom: true,
    attrs: {
      kind: { default: "spoiler" },
      value: { default: "" },
      label: { default: "" },
      href: { default: "" },
      src: { default: "" },
      alt: { default: "" },
      code: { default: "" },
    },
    toDOM: (node: ProseNode) => {
      const attrs = node.attrs as Record<string, string>;

      if (attrs["kind"] === "emoticon") {
        return [
          "img",
          {
            src: attrs["src"],
            alt: attrs["alt"],
            class: "emoticon",
            "data-emoticon": attrs["code"],
          },
        ];
      }

      if (attrs["kind"] === "mention") {
        return [
          "a",
          { href: attrs["href"], "data-mention-id": attrs["href"]?.replace("member:", "") },
          `@${attrs["label"]}`,
        ];
      }

      return ["span", { class: "spoiler" }, attrs["label"] ?? attrs["value"] ?? ""];
    },
    parseDOM: [
      {
        tag: "span[data-bulletin-token]",
        getAttrs: (dom: HTMLElement) => ({
          kind: dom.getAttribute("data-kind") ?? "spoiler",
          value: dom.getAttribute("data-value") ?? "",
          label: dom.textContent ?? "",
        }),
      },
    ],
    parseMarkdown: {
      match: (node: MarkdownChild) => node.type === "bulletinToken",
      runner: (state, node, type) => {
        const value = node as MarkdownChild & Record<string, string>;
        state.addNode(type, {
          kind: value["kind"],
          value: value["value"],
          label: value["label"] ?? "",
          href: value["href"] ?? "",
          src: value["src"] ?? "",
          alt: value["alt"] ?? "",
          code: value["code"] ?? "",
        });
      },
    },
    toMarkdown: {
      match: (node: ProseNode) => node.type.name === "bulletinToken",
      runner: (state, node) => {
        state.addNode("html", undefined, (node.attrs as Record<string, string>)["value"]);
      },
    },
  }));

  return [remark, schema] as const;
}
