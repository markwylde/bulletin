import type { Options } from "rehype-sanitize";
import { defaultSchema } from "rehype-sanitize";
import { type ContentProfile, MENTION_ATTRIBUTE } from "./types.ts";

type Schema = Options;

const CODE_CLASS = /^language-[a-z0-9+#-]+$/i;
const HLJS_CLASS = /^hljs(?:-[a-z0-9-]+)?$/i;

/** Attributes every profile keeps on top of the GitHub-style defaults. */
const COMMON_ATTRIBUTES: NonNullable<Schema["attributes"]> = {
  a: ["href", "rel", "title", MENTION_ATTRIBUTE],
  img: ["src", "alt", "title", ["className", "emoticon"]],
  code: [["className", CODE_CLASS, "hljs"]],
  pre: [["className", "hljs"]],
  span: [["className", HLJS_CLASS, "spoiler"]],
  "bl-embed": ["dataProvider", "dataEmbedId"],
  "bl-unfurl": ["dataUrl", "dataUrlHash"],
  "bl-attachment": ["dataId", "dataInline"],
};

const PROFILE_ATTRIBUTES: Record<ContentProfile, NonNullable<Schema["attributes"]>> = {
  post: COMMON_ATTRIBUTES,
  rules: COMMON_ATTRIBUTES,
  signature: COMMON_ATTRIBUTES,
  profile_field: COMMON_ATTRIBUTES,
};

const MARKDOWN_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "ul",
] as const;

const POST_TAGS = [
  ...MARKDOWN_TAGS,
  "bl-embed",
  "bl-unfurl",
  "bl-attachment",
  "img",
  "input",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
] as const;

const PROFILE_TAGS: Record<ContentProfile, readonly string[]> = {
  post: POST_TAGS,
  rules: POST_TAGS,
  // Signatures have their headings downgraded in the mdast step; tables are removed.
  signature: MARKDOWN_TAGS,
  // Profile fields are single lines of formatting, nothing structural.
  profile_field: ["a", "br", "code", "del", "em", "s", "span", "strong"],
};

function mergeAttributes(
  extra: NonNullable<Schema["attributes"]>,
): NonNullable<Schema["attributes"]> {
  const merged: Record<string, NonNullable<Schema["attributes"]>[string]> = {
    ...defaultSchema.attributes,
  };

  for (const [tag, definitions] of Object.entries(extra)) {
    merged[tag] = [...(merged[tag] ?? []), ...definitions];
  }

  return merged;
}

const schemas = new Map<ContentProfile, Schema>();

/** The allowlist sanitiser schema for one profile (deny by default, ADR 0007). */
export function profileSchema(profile: ContentProfile): Schema {
  const existing = schemas.get(profile);

  if (existing !== undefined) {
    return existing;
  }

  const schema: Schema = {
    ...defaultSchema,
    tagNames: [...PROFILE_TAGS[profile]],
    attributes: mergeAttributes(PROFILE_ATTRIBUTES[profile]),
    // Only these tags may make a clickable URL; `javascript:` and `data:` stay blocked.
    protocols: {
      ...defaultSchema.protocols,
      href: ["http", "https", "mailto"],
      src: ["http", "https"],
    },
  };

  schemas.set(profile, schema);
  return schema;
}
