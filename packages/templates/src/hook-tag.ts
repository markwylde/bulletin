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

/** Hook bodies keyed by hook name, contributed by plugins for the current generation. */
export type HookFragments = Readonly<Record<string, string>>;

export interface HookTagOptions {
  readonly fragments: HookFragments;
  /** Reports a hook without a fragment, or a fragment that fails to render. */
  readonly onError?: (error: HookRenderError) => void;
}

export interface HookRenderError {
  readonly hook: string;
  readonly reason: "unregistered" | "render_failed";
  readonly message: string;
}

/**
 * `{% hook "post.userbar.after" %}` renders the plugin fragments registered for that hook
 * point (ADR 0008). Fragment output goes through the same escaping rules as the theme.
 */
class HookTag extends Tag {
  private readonly options: HookTagOptions;
  private readonly hookName: Value;

  constructor(
    token: TagToken,
    remainingTokens: TopLevelToken[],
    liquid: Liquid,
    options: HookTagOptions,
  ) {
    super(token, remainingTokens, liquid);
    this.options = options;

    const tokenizer = new Tokenizer(token.args, liquid.options.operators);

    if (tokenizer.end()) {
      throw new Error('{% hook %} requires a hook name, e.g. {% hook "post.userbar.after" %}');
    }

    this.hookName = new Value(tokenizer.readValueOrThrow().getText(), liquid);
  }

  *render(context: Context, emitter: Emitter) {
    const name = (yield this.hookName.value(context)) as unknown;

    if (typeof name !== "string" || name === "") {
      this.options.onError?.({
        hook: "",
        reason: "unregistered",
        message: "hook name is not a string",
      });
      return;
    }

    const body = this.options.fragments[name];

    if (body === undefined) {
      this.options.onError?.({
        hook: name,
        reason: "unregistered",
        message: `no fragment registered for hook "${name}"`,
      });
      return;
    }

    try {
      emitter.write((yield this.liquid.parseAndRender(body, context)) as string);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.options.onError?.({
        hook: name,
        reason: "render_failed",
        message: `hook "${name}" failed to render: ${detail}`,
      });
    }
  }
}

/** Registers `{% hook "name" %}` on a LiquidJS engine (ADR 0008). */
export function registerHookTag(engine: Liquid, options: HookTagOptions): void {
  class BoundHookTag extends HookTag {
    constructor(token: TagToken, remainingTokens: TopLevelToken[], liquid: Liquid) {
      super(token, remainingTokens, liquid, options);
    }
  }

  engine.registerTag("hook", BoundHookTag);
}
