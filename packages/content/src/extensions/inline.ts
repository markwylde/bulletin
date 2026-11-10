import type { Image, Parent, PhrasingContent, Root, Text } from "mdast";
import type { MentionedMember, MentionResolver } from "../types.ts";

interface CustomNode extends Parent {
  readonly type: string;
  data?: Record<string, unknown>;
}

const MENTION = /(^|[\s([{"'“‘])@([\p{L}\p{N}_-](?:[\p{L}\p{N}_.-]{0,30}[\p{L}\p{N}_-])?)/gu;
const EMOTICON = /:([a-z0-9_+-]{1,32}):/gi;
const SPOILER = /\|\|([^|\n]+)\|\|/g;

const SKIPPED_PARENTS = new Set(["link", "linkReference", "code", "inlineCode", "html"]);

function isParent(node: unknown): node is Parent {
  return (
    typeof node === "object" &&
    node !== null &&
    Array.isArray((node as { children?: unknown }).children)
  );
}

function text(value: string): Text {
  return { type: "text", value };
}

/** Replaces a text node's children with `build`'s pieces, keeping non-text nodes untouched. */
function expandText(
  children: readonly PhrasingContent[],
  build: (value: string) => PhrasingContent[],
): PhrasingContent[] {
  const result: PhrasingContent[] = [];

  for (const child of children) {
    if (child.type === "text") {
      result.push(...build(child.value));
    } else {
      result.push(child);
    }
  }

  return result;
}

function spoilerNode(value: string): CustomNode {
  return {
    type: "spoiler",
    children: [{ type: "text", value }],
    data: { hName: "span", hProperties: { className: ["spoiler"] } },
  };
}

function emoticonNode(src: string, alt: string, code: string): Image {
  return {
    type: "image",
    url: src,
    alt,
    data: { hProperties: { className: ["emoticon"], "data-emoticon": code } },
  };
}

function withSpoilers(value: string): PhrasingContent[] {
  const pieces: PhrasingContent[] = [];
  let cursor = 0;

  for (const match of value.matchAll(SPOILER)) {
    const start = match.index ?? 0;
    const body = match[1];

    if (body === undefined) {
      continue;
    }

    if (start > cursor) {
      pieces.push(text(value.slice(cursor, start)));
    }

    pieces.push(spoilerNode(body) as unknown as PhrasingContent);
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

function withEmoticons(
  pieces: readonly PhrasingContent[],
  emoticons: ReadonlyMap<string, { src: string; alt: string }>,
): PhrasingContent[] {
  if (emoticons.size === 0) {
    return [...pieces];
  }

  return expandText(pieces, (value) => {
    const result: PhrasingContent[] = [];
    let cursor = 0;

    for (const match of value.matchAll(EMOTICON)) {
      const start = match.index ?? 0;
      const code = match[1]?.toLowerCase();
      const emoticon = code === undefined ? undefined : emoticons.get(code);

      if (emoticon === undefined || code === undefined) {
        continue;
      }

      if (start > cursor) {
        result.push(text(value.slice(cursor, start)));
      }

      result.push(emoticonNode(emoticon.src, emoticon.alt, code));
      cursor = start + match[0].length;
    }

    if (cursor === 0) {
      return [text(value)];
    }

    if (cursor < value.length) {
      result.push(text(value.slice(cursor)));
    }

    return result;
  });
}

const MEMBER_LINK = /^member:(\d+)$/;

/** Resolves the editor's unambiguous `@[Name](member:<id>)` token before plain @names. */
async function withMemberLinks(
  pieces: readonly PhrasingContent[],
  resolver: MentionResolver,
  mentioned: Set<string>,
): Promise<PhrasingContent[]> {
  const result: PhrasingContent[] = [];

  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const next = pieces[index + 1];

    if (piece?.type === "text" && piece.value.endsWith("@") && next?.type === "link") {
      const match = MEMBER_LINK.exec(next.url);

      if (match?.[1] !== undefined) {
        const id = match[1];
        const member =
          resolver.resolveById === undefined
            ? await resolver.resolve(
                next.children.map((child) => ("value" in child ? child.value : "")).join(""),
              )
            : await resolver.resolveById(id);

        if (member !== null) {
          const before = piece.value.slice(0, -1);

          if (before !== "") {
            result.push(text(before));
          }

          mentioned.add(member.id);
          result.push({
            type: "link",
            url: member.url,
            title: null,
            children: [text(`@${member.displayName}`)],
          });
          index += 1;
          continue;
        }
      }
    }

    result.push(piece as PhrasingContent);
  }

  return result;
}

async function withMentions(
  pieces: readonly PhrasingContent[],
  resolver: MentionResolver,
  cache: Map<string, MentionedMember | null>,
  mentioned: Set<string>,
): Promise<PhrasingContent[]> {
  const result: PhrasingContent[] = [];

  for (const piece of pieces) {
    if (piece.type !== "text") {
      result.push(piece);
      continue;
    }

    const value = piece.value;
    let cursor = 0;

    for (const match of value.matchAll(MENTION)) {
      const name = match[2];

      if (name === undefined) {
        continue;
      }

      const start = match.index ?? 0;
      const prefix = match[1] ?? "";
      let member = cache.get(name.toLowerCase());

      if (member === undefined) {
        member = await resolver.resolve(name);
        cache.set(name.toLowerCase(), member);
      }

      if (member === null) {
        continue;
      }

      const mentionStart = start + prefix.length;

      if (mentionStart > cursor) {
        result.push(text(value.slice(cursor, mentionStart)));
      }

      mentioned.add(member.id);
      result.push({
        type: "link",
        url: member.url,
        title: null,
        children: [text(`@${member.displayName}`)],
      });
      cursor = mentionStart + 1 + name.length;
    }

    if (cursor === 0) {
      result.push(piece);
    } else if (cursor < value.length) {
      result.push(text(value.slice(cursor)));
    }
  }

  return result;
}

async function walk(
  parent: Parent,
  transform: (children: readonly PhrasingContent[]) => Promise<PhrasingContent[]>,
): Promise<void> {
  const next: PhrasingContent[] = [];

  for (const child of parent.children as PhrasingContent[]) {
    if (isParent(child) && !SKIPPED_PARENTS.has(child.type)) {
      await walk(child, transform);
    }

    next.push(child);
  }

  parent.children = (await transform(next)) as Parent["children"];
}

export interface InlineExtensionOptions {
  readonly emoticons?: readonly {
    readonly code: string;
    readonly src: string;
    readonly alt: string;
  }[];
  readonly mentions?: MentionResolver;
}

export interface InlineExtensionResult {
  readonly mentionedMemberIds: readonly string[];
}

/**
 * Applies the inline Bulletin extensions to text nodes: spoilers, `:code:` emoticons and
 * `@DisplayName` mentions. Code spans/blocks and existing links are left alone.
 */
export async function applyInlineExtensions(
  tree: Root,
  options: InlineExtensionOptions = {},
): Promise<InlineExtensionResult> {
  const emoticons = new Map(
    (options.emoticons ?? []).map((emoticon) => [emoticon.code.toLowerCase(), emoticon]),
  );
  const mentioned = new Set<string>();
  const cache = new Map<string, MentionedMember | null>();

  const transform = async (children: readonly PhrasingContent[]): Promise<PhrasingContent[]> => {
    let next = children.flatMap((child) =>
      child.type === "text" ? withSpoilers(child.value ?? "") : [child],
    );
    next = withEmoticons(next, emoticons);

    if (options.mentions !== undefined) {
      next = await withMemberLinks(next, options.mentions, mentioned);
      next = await withMentions(next, options.mentions, cache, mentioned);
    }

    return next;
  };

  await walk(tree, transform);
  return { mentionedMemberIds: [...mentioned] };
}
