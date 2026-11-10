import {
  type Context,
  type Emitter,
  type Liquid,
  Tag,
  type TagToken,
  Tokenizer,
  type TopLevelToken,
  Value,
} from "liquidjs";
import { readRuntime } from "./runtime.ts";

/** Hook bodies keyed by hook name, contributed by plugins for the current generation. */
export type HookFragments = Readonly<Record<string, string>>;

export interface HookRenderError {
  readonly hook: string;
  readonly reason: "unregistered" | "render_failed";
  readonly message: string;
}

/**
 * `{% hook "post.userbar.after" %}` renders the plugin fragments registered for that hook
 * point (ADR 0008). Fragments come from the render runtime, so a plugin-generation change is
 * data, not a recompile.
 */
class HookTag extends Tag {
  private readonly hookName: Value;

  constructor(token: TagToken, remainingTokens: TopLevelToken[], liquid: Liquid) {
    super(token, remainingTokens, liquid);

    const tokenizer = new Tokenizer(token.args, liquid.options.operators);

    if (tokenizer.end()) {
      throw new Error('{% hook %} requires a hook name, e.g. {% hook "post.userbar.after" %}');
    }

    this.hookName = new Value(tokenizer.readValueOrThrow().getText(), liquid);
  }

  *render(context: Context, emitter: Emitter) {
    const name = (yield this.hookName.value(context)) as unknown;

    const runtime = readRuntime(context);

    if (typeof name !== "string" || name === "") {
      runtime.report?.("unregistered: hook name is not a string");
      return;
    }

    const body = runtime.hooks[name];

    if (body === undefined) {
      runtime.report?.(`unregistered: no fragment registered for hook "${name}"`);
      return;
    }

    try {
      emitter.write((yield this.liquid.parseAndRender(body, context)) as string);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      runtime.report?.(`render_failed: hook "${name}" failed to render: ${detail}`);
    }
  }
}

/** Registers `{% hook "name" %}` on a LiquidJS engine (ADR 0008). */
export function registerHookTag(engine: Liquid): void {
  engine.registerTag("hook", HookTag);
}
