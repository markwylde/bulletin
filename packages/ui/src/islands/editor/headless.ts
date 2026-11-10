import {
  InitReady,
  marksCtx,
  nodesCtx,
  remarkPluginsCtx,
  remarkStringifyOptionsCtx,
} from "@milkdown/kit/core";
import { Clock, Container, Ctx } from "@milkdown/kit/ctx";
import type { Node as ProseNode, Schema } from "@milkdown/kit/prose/model";
import { Schema as ProseSchema } from "@milkdown/kit/prose/model";
import { ParserState, type RemarkParser, SerializerState } from "@milkdown/kit/transformer";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import { preprocessRawBlocks, restoreRawBlocks } from "./milkdown.ts";
import { bulletinSchemaPlugins } from "./plugins.ts";
import type { EditorEmoticon } from "./types.ts";

interface RoundTrip {
  readonly schema: Schema;
  readonly parse: ReturnType<typeof ParserState.create>;
  readonly serialize: ReturnType<typeof SerializerState.create>;
}

const cached = new Map<string, RoundTrip>();

function cacheKey(emoticons: readonly EditorEmoticon[]): string {
  return emoticons
    .map((emoticon) => `${emoticon.code}=${emoticon.src}=${emoticon.alt}`)
    .sort()
    .join("|");
}

/**
 * Milkdown's transformer without an EditorView. It installs the same schema plugins and
 * remark processor the browser editor builds, including Bulletin's custom token nodes, so
 * the round-trip corpus runs headlessly in `bun test` (ADR 0007).
 */
async function roundTrip(emoticons: readonly EditorEmoticon[]): Promise<RoundTrip> {
  const key = cacheKey(emoticons);
  const existing = cached.get(key);

  if (existing !== undefined) {
    return existing;
  }

  const ctx = new Ctx(new Container(), new Clock());
  ctx.inject(nodesCtx, []);
  ctx.inject(marksCtx, []);
  ctx.inject(remarkPluginsCtx, []);
  ctx.inject(remarkStringifyOptionsCtx);
  // The browser's engine records this timer; `$remark` plugins wait for it before they
  // register their processor extension, so the headless context resolves it the same way.
  ctx.record(InitReady);

  const pending: Array<Promise<unknown>> = [];

  for (const plugin of bulletinSchemaPlugins(emoticons)) {
    const handler = plugin(ctx);

    if (typeof handler === "function") {
      pending.push(Promise.resolve(handler()));
    }
  }

  ctx.done(InitReady);
  await Promise.all(pending);

  const schema = new ProseSchema({
    nodes: Object.fromEntries(ctx.get(nodesCtx)),
    marks: Object.fromEntries(ctx.get(marksCtx)),
  });
  // The browser builds its processor the same way: the remark presets, then every remark
  // plugin registered by a schema plugin (including Bulletin's token transform).
  const processor: RemarkParser = remark();
  processor.use(remarkGfm);

  for (const entry of ctx.get(remarkPluginsCtx)) {
    processor.use(entry.plugin, entry.options);
  }

  const value: RoundTrip = {
    schema,
    parse: ParserState.create(schema, processor),
    serialize: SerializerState.create(schema, processor),
  };

  cached.set(key, value);
  return value;
}

export interface RoundTripOptions {
  /** The emoticon set the editor was given; `:code:` only becomes a node when it exists. */
  readonly emoticons?: readonly EditorEmoticon[];
  /** Applies an edit to the parsed document, as typing in the browser would. */
  readonly edit?: (document: ProseNode, schema: Schema) => ProseNode;
}

/** Markdown → Milkdown document → canonical markdown, preserving unknown raw blocks. */
export async function roundTripMarkdown(
  markdown: string,
  options: RoundTripOptions = {},
): Promise<string> {
  const { schema, parse, serialize } = await roundTrip(options.emoticons ?? []);
  const processed = preprocessRawBlocks(markdown);
  const document = parse(processed.markdown);

  return restoreRawBlocks(
    serialize(options.edit === undefined ? document : options.edit(document, schema)),
    processed.raw,
  );
}

/**
 * Saving without edits returns the exact original markdown, including syntax the editor does
 * not understand (ADR 0007). Once edited, the editor's canonical serialisation is stored.
 */
export function markdownForSave(initial: string, current: string, dirty: boolean): string {
  return dirty ? current : initial;
}
