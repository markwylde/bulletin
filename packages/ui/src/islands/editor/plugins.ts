import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { schema as commonmarkSchema } from "@milkdown/kit/preset/commonmark";
import { schema as gfmSchema } from "@milkdown/kit/preset/gfm";
import { createBulletinTokenPlugins } from "./tokens.ts";
import type { EditorEmoticon } from "./types.ts";

/** Bulletin's custom mention, emoticon and spoiler nodes, as the browser editor installs them. */
export function bulletinTokenPlugins(emoticons: readonly EditorEmoticon[]): MilkdownPlugin[] {
  return createBulletinTokenPlugins(emoticons).flat() as MilkdownPlugin[];
}

/**
 * The schema the browser editor and the headless round-trip corpus share: the CommonMark and
 * GFM node/mark schemas plus Bulletin's token nodes. The browser installs the full presets
 * (which carry these schemas) and this same token plugin list, so the corpus cannot drift
 * from what the browser parses and serialises (ADR 0007).
 */
export function bulletinSchemaPlugins(emoticons: readonly EditorEmoticon[]): MilkdownPlugin[] {
  return [...commonmarkSchema, ...gfmSchema, ...bulletinTokenPlugins(emoticons)];
}
