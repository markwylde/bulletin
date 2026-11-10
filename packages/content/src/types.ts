/** Marks mention links in stored HTML so reads can gate them by the viewer's flag (ADR 0010). */
export const MENTION_ATTRIBUTE = "dataMention";

/** Profile selectors for the sanitised HTML schema (ADR 0007). */
export const CONTENT_PROFILES = ["post", "signature", "profile_field", "rules"] as const;
export type ContentProfile = (typeof CONTENT_PROFILES)[number];

/** Where the saved content will live; quote sources are checked against it (ADR 0007). */
export type SourceContext =
  | { readonly kind: "forum_post"; readonly forumId: string }
  | { readonly kind: "conversation_message"; readonly conversationId: string };

export interface MentionedMember {
  readonly id: string;
  readonly displayName: string;
  readonly url: string;
}

export interface MentionResolver {
  /** Resolves a display name typed after `@`; null means "no such member". */
  resolve(name: string): Promise<MentionedMember | null>;
  /** Resolves the unambiguous editor token `@[Name](member:<id>)`. */
  resolveById?(id: string): Promise<MentionedMember | null>;
}

export interface Emoticon {
  readonly code: string;
  readonly src: string;
  readonly alt: string;
}

export type QuoteSourceKind = "post" | "message";

export interface QuoteSourceRef {
  readonly kind: QuoteSourceKind;
  readonly id: string;
}

export interface QuoteSource {
  readonly ref: QuoteSourceRef;
  readonly sourceAuthorId: string | null;
  readonly bodyMd: string;
  /** Forum id for post quotes, conversation id for message quotes. */
  readonly contextId: string | null;
}

/**
 * The write-side quote check (ADR 0007). Implementations are wired by `topics-posts` (posts)
 * and `conversations` (messages); the pipeline only knows this interface.
 */
export interface QuoteSourceResolver {
  /** True when `authorId` may read the source post/message right now. */
  canRead(ref: QuoteSourceRef, authorId: string): Promise<boolean>;
  /** Loads the source body; null when it does not exist or was deleted. */
  load(ref: QuoteSourceRef): Promise<QuoteSource | null>;
}

export interface QuoteSnapshotDraft {
  readonly sourceKind: QuoteSourceKind;
  readonly sourceId: string;
  readonly sourceAuthorId: string | null;
  readonly bodyMd: string;
  readonly bodyHtml: string;
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
}

/**
 * Persists one snapshot and returns its id. Called inside the caller's posting transaction so
 * a later validation failure rolls the snapshot back too.
 */
export interface QuoteSnapshotWriter {
  create(draft: QuoteSnapshotDraft): Promise<string>;
}

export interface QuotePipeline {
  readonly resolver: QuoteSourceResolver;
  readonly snapshots: QuoteSnapshotWriter;
}

export interface ReplaceWordRule {
  /** Literal word/phrase, matched case-insensitively. */
  readonly word: string;
  readonly replacement: string;
}

export interface ReplaceWords {
  /** Folded into `render_version` so a filter edit triggers the re-render job (ADR 0007). */
  readonly version: number;
  readonly rules: readonly ReplaceWordRule[];
}

export interface RenderResult {
  readonly bodyMd: string;
  readonly bodyHtml: string;
  readonly bodyText: string;
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
  /** Member ids mentioned in the content, for notifications (ADR 0011). */
  readonly mentionedMemberIds: readonly string[];
  /** One entry per distinct quoted forum; declared as a visibility dependency later. */
  readonly quotedForumIds: readonly string[];
  /** The source of every quote placeholder, in document order. */
  readonly quoteSources: readonly QuoteSourceRef[];
}

export class ContentError extends Error {
  readonly code:
    | "quote_source_invalid"
    | "quote_context_invalid"
    | "quote_unreadable"
    | "blocked_word"
    | "too_many_links";

  constructor(code: ContentError["code"], message: string) {
    super(message);
    this.name = "ContentError";
    this.code = code;
  }
}

/** An admin-configured embed provider (ADR 0007). `urlPattern` captures the id in group 1. */
export interface EmbedProvider {
  readonly key: string;
  readonly title: string;
  readonly urlPattern: string;
  /** HTTPS template with `{id}` replaced by the captured id. */
  readonly embedUrl: string;
}

export interface EmbedMatch {
  readonly provider: EmbedProvider;
  readonly id: string;
  readonly url: string;
  readonly embedUrl: string;
}

export interface UnfurlPreview {
  readonly kind: "opengraph" | "oembed";
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly siteName: string | null;
  readonly provider: string | null;
  readonly imageUrl: string | null;
}
