import { marksCtx, nodesCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { Clock, Container, Ctx } from "@milkdown/kit/ctx";
import { schema as commonmarkSchema } from "@milkdown/kit/preset/commonmark";
import { schema as gfmSchema } from "@milkdown/kit/preset/gfm";
import { Schema } from "@milkdown/kit/prose/model";
import { ParserState, SerializerState } from "@milkdown/kit/transformer";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import { preprocessRawBlocks, restoreRawBlocks } from "./milkdown.ts";

interface RoundTrip {
  readonly parse: ReturnType<typeof ParserState.create>;
  readonly serialize: ReturnType<typeof SerializerState.create>;
}

let cached: RoundTrip | null = null;

/**
 * Milkdown's transformer without an EditorView: the same preset schemas and remark instance
 * the browser editor uses, so the round-trip corpus runs headlessly in `bun test` (ADR 0007).
 */
async function roundTrip(): Promise<RoundTrip> {
  if (cached !== null) {
    return cached;
  }

  const ctx = new Ctx(new Container(), new Clock());
  ctx.inject(nodesCtx, []);
  ctx.inject(marksCtx, []);
  ctx.inject(remarkStringifyOptionsCtx);

  for (const plugin of [...commonmarkSchema, ...gfmSchema]) {
    const handler = plugin(ctx);

    if (typeof handler === "function") {
      await handler();
    }
  }

  const schema = new Schema({
    nodes: Object.fromEntries(ctx.get(nodesCtx)),
    marks: Object.fromEntries(ctx.get(marksCtx)),
  });
  const processor = remark().use(remarkGfm);

  cached = {
    parse: ParserState.create(schema, processor),
    serialize: SerializerState.create(schema, processor),
  };

  return cached;
}

/** Markdown → Milkdown document → canonical markdown, preserving unknown raw blocks. */
export async function roundTripMarkdown(markdown: string): Promise<string> {
  const { parse, serialize } = await roundTrip();
  const processed = preprocessRawBlocks(markdown);
  return restoreRawBlocks(serialize(parse(processed.markdown)), processed.raw);
}

/**
 * Saving without edits returns the exact original markdown, including syntax the editor does
 * not understand (ADR 0007). Once edited, the editor's canonical serialisation is stored.
 */
export function markdownForSave(initial: string, current: string, dirty: boolean): string {
  return dirty ? current : initial;
}
