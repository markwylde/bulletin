import type { MessageValues, Translator } from "@bulletin/i18n";
import {
  type Context,
  type Emitter,
  Hash,
  type Liquid,
  Tag,
  type TagToken,
  Tokenizer,
  type TopLevelToken,
  Value,
} from "liquidjs";
import { escapeHtml } from "./html.ts";

class TranslationTag extends Tag {
  private readonly translate: Translator;
  private readonly key: Value;
  private readonly values: Hash | undefined;
  private readonly vars: Value | undefined;

  constructor(
    token: TagToken,
    remainingTokens: TopLevelToken[],
    liquid: Liquid,
    translate: Translator,
  ) {
    super(token, remainingTokens, liquid);
    this.translate = translate;

    const tokenizer = new Tokenizer(token.args, liquid.options.operators);

    if (tokenizer.end()) {
      throw new Error("{% t %} requires a message key");
    }

    this.key = new Value(tokenizer.readValueOrThrow().getText(), liquid);

    const rest = tokenizer.remaining().trim();
    const usesNamedArguments = rest.includes(":");

    this.values =
      rest === "" || !usesNamedArguments
        ? undefined
        : new Hash(new Tokenizer(rest, liquid.options.operators));
    this.vars = rest === "" || usesNamedArguments ? undefined : new Value(rest, liquid);
  }

  *render(context: Context, emitter: Emitter) {
    const key = (yield this.key.value(context)) as unknown;
    let values: MessageValues = {};

    if (this.vars !== undefined) {
      const resolved = (yield this.vars.value(context)) as unknown;

      if (resolved !== null && typeof resolved === "object" && !Array.isArray(resolved)) {
        values = resolved as MessageValues;
      }
    } else if (this.values !== undefined) {
      values = (yield this.values.render(context)) as MessageValues;
    }

    if (typeof key !== "string" || key === "") {
      throw new Error("{% t %} requires a non-empty message key");
    }

    emitter.write(escapeHtml(this.translate(key, values)));
  }
}

export interface TranslationTagOptions {
  readonly translate: Translator;
}

/**
 * Registers `{% t "key" vars %}`, `{% t "key" count: n %}` and the no-arguments form on a
 * LiquidJS engine. Output is always HTML-escaped, matching the template autoescape contract.
 */
export function registerTranslationTag(engine: Liquid, options: TranslationTagOptions): void {
  class BoundTranslationTag extends TranslationTag {
    constructor(token: TagToken, remainingTokens: TopLevelToken[], liquid: Liquid) {
      super(token, remainingTokens, liquid, options.translate);
    }
  }

  engine.registerTag("t", BoundTranslationTag);
}
