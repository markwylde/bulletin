import type { EmbedProvider, Emoticon, MentionResolver } from "@bulletin/content";
import type { SQL } from "bun";
import { listEmbedProviders } from "./embeds.ts";
import { listRenderEmoticons } from "./emoticons.ts";
import { createMentionResolver } from "./mentions.ts";

export interface ContentRenderDependencies {
  readonly emoticons: readonly Emoticon[];
  readonly mentions: MentionResolver;
  readonly embeds: readonly EmbedProvider[];
}

/**
 * The rendering inputs that are not part of the markdown itself. Background re-renders must
 * load the current rows, otherwise stored `@name`, `:code:` and standalone embed URLs degrade
 * to plain text when a stale row is upgraded (ADR 0007).
 */
export async function loadContentRenderDependencies(sql: SQL): Promise<ContentRenderDependencies> {
  return {
    emoticons: await listRenderEmoticons(sql),
    mentions: createMentionResolver(sql),
    embeds: await listEmbedProviders(sql),
  };
}
