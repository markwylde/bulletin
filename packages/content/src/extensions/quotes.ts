import type { Parent, Root } from "mdast";
import {
  ContentError,
  type QuoteSource,
  type QuoteSourceKind,
  type QuoteSourceRef,
  type SourceContext,
} from "../types.ts";

interface DirectiveNode extends Parent {
  type: "containerDirective";
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  data?: Record<string, unknown>;
}

const SOURCE = /^(post|message):(\d+)$/;

function isDirective(node: unknown): node is DirectiveNode {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as { type?: unknown }).type === "containerDirective"
  );
}

export function parseQuoteSource(value: string | null | undefined): QuoteSourceRef {
  const match = SOURCE.exec(value?.trim() ?? "");
  const kind = match?.[1] as QuoteSourceKind | undefined;
  const id = match?.[2];

  if (kind === undefined || id === undefined) {
    throw new ContentError(
      "quote_source_invalid",
      `Quote source must be post:<id> or message:<id>, received "${value ?? ""}"`,
    );
  }

  return { kind, id };
}

function checkContext(context: SourceContext, source: QuoteSource): void {
  if (context.kind === "forum_post") {
    if (source.ref.kind !== "post") {
      throw new ContentError(
        "quote_context_invalid",
        "Forum posts may quote only forum posts (ADR 0007)",
      );
    }

    return;
  }

  if (source.ref.kind !== "message" || source.contextId !== context.conversationId) {
    throw new ContentError(
      "quote_context_invalid",
      "Conversation messages may quote only messages from the same conversation (ADR 0007)",
    );
  }
}

export interface QuoteDirectiveOptions {
  readonly context: SourceContext;
  readonly authorId: string;
  readonly resolver: {
    canRead(ref: QuoteSourceRef, authorId: string): Promise<boolean>;
    load(ref: QuoteSourceRef): Promise<QuoteSource | null>;
  };
  /** Persists a snapshot and returns its id; called once per distinct source. */
  readonly createSnapshot: (source: QuoteSource) => Promise<string>;
  /** Snapshot bodies drop nested quotes instead of resolving them again. */
  readonly strip?: boolean;
}

export interface QuotePlaceholder {
  readonly token: string;
  readonly kind: QuoteSourceKind;
  readonly id: string;
  readonly snapshotId: string;
}

export interface QuoteDirectiveResult {
  readonly quoteSources: readonly QuoteSourceRef[];
  readonly quotedForumIds: readonly string[];
  readonly placeholders: readonly QuotePlaceholder[];
}

function collectDirectives(parent: Parent): DirectiveNode[] {
  const found: DirectiveNode[] = [];

  for (const child of parent.children) {
    if (isDirective(child)) {
      if (child.name === "quote") {
        found.push(child);
      }

      continue;
    }

    if (typeof child === "object" && child !== null && Array.isArray((child as Parent).children)) {
      found.push(...collectDirectives(child as Parent));
    }
  }

  return found;
}

function removeDirectives(parent: Parent): void {
  parent.children = parent.children.filter((child) => !isDirective(child)) as Parent["children"];

  for (const child of parent.children) {
    if (typeof child === "object" && child !== null && Array.isArray((child as Parent).children)) {
      removeDirectives(child as Parent);
    }
  }
}

/**
 * Validates every `:::quote{source=…}` block, creates its snapshot and rewrites the node to
 * the `<bl-quote>` placeholder stored in `body_html` (ADR 0007). In snapshot mode the blocks
 * are removed so a quote never captures another quote's text.
 */
export async function applyQuoteDirectives(
  tree: Root,
  options: QuoteDirectiveOptions,
): Promise<QuoteDirectiveResult> {
  const directives = collectDirectives(tree);

  if (options.strip === true) {
    removeDirectives(tree);
    return { quoteSources: [], quotedForumIds: [], placeholders: [] };
  }

  const snapshots = new Map<string, string>();
  const quoteSources: QuoteSourceRef[] = [];
  const quotedForumIds = new Set<string>();
  const placeholders: QuotePlaceholder[] = [];

  for (const directive of directives) {
    const ref = parseQuoteSource(directive.attributes?.source);

    if (!(await options.resolver.canRead(ref, options.authorId))) {
      throw new ContentError(
        "quote_unreadable",
        `Cannot quote ${ref.kind} ${ref.id}: the author cannot read it`,
      );
    }

    const source = await options.resolver.load(ref);

    if (source === null) {
      throw new ContentError("quote_unreadable", `Cannot quote ${ref.kind} ${ref.id}: not found`);
    }

    checkContext(options.context, source);

    const key = `${ref.kind}:${ref.id}`;
    let snapshotId = snapshots.get(key);

    if (snapshotId === undefined) {
      snapshotId = await options.createSnapshot(source);
      snapshots.set(key, snapshotId);
    }

    const token = `BLQUOTE_${crypto.randomUUID()}`;
    directive.children = [{ type: "text", value: token }];
    directive.data = { ...(directive.data ?? {}), hName: "p" };
    placeholders.push({ token, kind: ref.kind, id: ref.id, snapshotId });

    if (!quoteSources.some((entry) => entry.kind === ref.kind && entry.id === ref.id)) {
      quoteSources.push(ref);
    }

    if (ref.kind === "post" && source.contextId !== null) {
      quotedForumIds.add(source.contextId);
    }
  }

  return { quoteSources, quotedForumIds: [...quotedForumIds].sort(), placeholders };
}
