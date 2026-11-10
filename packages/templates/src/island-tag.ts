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
import { escapeAttribute } from "./html.ts";
import { readRuntime } from "./runtime.ts";

/** The result of validating an island's props against its schema. */
export type IslandProps =
  | { readonly ok: true; readonly props: object }
  | { readonly ok: false; readonly reason: string };

/** One entry of the fixed island registry (ADR 0008). */
export interface IslandDefinition {
  /** Validates untrusted template props; never throws. */
  readonly parse: (input: unknown) => IslandProps;
  /** Server-renders the component; the same component hydrates in the browser. */
  readonly render: (props: object) => string;
}

export type IslandRegistry = Readonly<Record<string, IslandDefinition>>;

export interface IslandRenderError {
  readonly island: string;
  readonly reason: "unknown_island" | "invalid_props" | "render_failed";
  readonly message: string;
}

export interface IslandTagOptions {
  readonly islands: IslandRegistry;
}

/**
 * `<bl-island data-name data-props>` carries the hydrated component; the SSR markup sits
 * inside it so the island is visible before its chunk loads (ADR 0008).
 */
function islandMarkup(name: string, props: object, html: string): string {
  const serialised = escapeAttribute(JSON.stringify(props) ?? "{}");
  return `<bl-island data-name="${escapeAttribute(name)}" data-props="${serialised}">${html}</bl-island>`;
}

class IslandTag extends Tag {
  private readonly options: IslandTagOptions;
  private readonly islandName: Value;
  private readonly values: Hash | undefined;
  private readonly vars: Value | undefined;

  constructor(
    token: TagToken,
    remainingTokens: TopLevelToken[],
    liquid: Liquid,
    options: IslandTagOptions,
  ) {
    super(token, remainingTokens, liquid);
    this.options = options;

    const tokenizer = new Tokenizer(token.args, liquid.options.operators);

    if (tokenizer.end()) {
      throw new Error('{% island %} requires an island name, e.g. {% island "Editor" props %}');
    }

    this.islandName = new Value(tokenizer.readValueOrThrow().getText(), liquid);

    const rest = tokenizer.remaining().trim();
    const usesNamedArguments = rest.includes(":");

    this.values =
      rest === "" || !usesNamedArguments
        ? undefined
        : new Hash(new Tokenizer(rest, liquid.options.operators));
    this.vars = rest === "" || usesNamedArguments ? undefined : new Value(rest, liquid);
  }

  /** Reports the rejection and omits the island; the rest of the page renders (ADR 0008). */
  private fail(error: IslandRenderError, context: Context): void {
    readRuntime(context).report?.(`${error.reason}: ${error.message}`);
  }

  *render(context: Context, emitter: Emitter) {
    const name = (yield this.islandName.value(context)) as unknown;

    if (typeof name !== "string" || name === "") {
      this.fail(
        { island: "", reason: "unknown_island", message: "island name is not a string" },
        context,
      );
      return;
    }

    const definition = this.options.islands[name];

    if (definition === undefined) {
      this.fail(
        { island: name, reason: "unknown_island", message: `unknown island "${name}"` },
        context,
      );
      return;
    }

    let input: unknown = {};

    if (this.vars !== undefined) {
      input = (yield this.vars.value(context)) as unknown;
    } else if (this.values !== undefined) {
      input = (yield this.values.render(context)) as unknown;
    }

    const parsed = definition.parse(input);

    if (!parsed.ok) {
      this.fail(
        {
          island: name,
          reason: "invalid_props",
          message: `invalid props for island "${name}": ${parsed.reason}`,
        },
        context,
      );
      return;
    }

    let html: string;

    try {
      html = definition.render(parsed.props);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.fail(
        {
          island: name,
          reason: "render_failed",
          message: `island "${name}" failed to render: ${detail}`,
        },
        context,
      );
      return;
    }

    emitter.write(islandMarkup(name, parsed.props, html));
  }
}

/** Registers the fixed-registry `{% island "Name" props %}` tag (ADR 0008). */
export function registerIslandTag(engine: Liquid, options: IslandTagOptions): void {
  class BoundIslandTag extends IslandTag {
    constructor(token: TagToken, remainingTokens: TopLevelToken[], liquid: Liquid) {
      super(token, remainingTokens, liquid, options);
    }
  }

  engine.registerTag("island", BoundIslandTag);
}
