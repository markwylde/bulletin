import { describe, expect, test } from "bun:test";
import { renderContent } from "./pipeline.ts";
import {
  ContentError,
  type QuoteSnapshotDraft,
  type QuoteSource,
  type QuoteSourceRef,
} from "./types.ts";

const POST: QuoteSource = {
  ref: { kind: "post", id: "5" },
  sourceAuthorId: "2",
  bodyMd: "The source says **zebra**",
  contextId: "3",
};

interface Fixture {
  readonly resolver: {
    canRead(ref: QuoteSourceRef, authorId: string): Promise<boolean>;
    load(ref: QuoteSourceRef): Promise<QuoteSource | null>;
  };
  readonly snapshots: { create(draft: QuoteSnapshotDraft): Promise<string> };
  readonly drafts: QuoteSnapshotDraft[];
  readonly read: string[];
}

function fixture(options: {
  readonly sources: readonly QuoteSource[];
  readonly readable?: readonly string[];
}): Fixture {
  const drafts: QuoteSnapshotDraft[] = [];
  const read: string[] = [];
  const readable = new Set(options.readable ?? options.sources.map((source) => key(source.ref)));

  return {
    resolver: {
      async canRead(ref, authorId) {
        read.push(`canRead:${key(ref)}:${authorId}`);
        return readable.has(key(ref));
      },
      async load(ref) {
        return options.sources.find((source) => key(source.ref) === key(ref)) ?? null;
      },
    },
    snapshots: {
      async create(draft) {
        drafts.push(draft);
        return String(drafts.length);
      },
    },
    drafts,
    read,
  };
}

function key(ref: QuoteSourceRef): string {
  return `${ref.kind}:${ref.id}`;
}

function quote(source: string): string {
  return `Before\n\n:::quote{source="${source}"}\nquoted text is not trusted\n:::\n\nAfter`;
}

describe("quote snapshots", () => {
  test("renders a placeholder and stores the source snapshot", async () => {
    const quotes = fixture({ sources: [POST] });
    const result = await renderContent(quote("post:5"), {
      profile: "post",
      context: { kind: "forum_post", forumId: "1" },
      authorId: "7",
      quotes,
    });

    expect(result.bodyHtml).toContain(
      '<bl-quote data-source-kind="post" data-source="5" data-snapshot="1"></bl-quote>',
    );
    expect(result.bodyHtml).not.toContain("quoted text is not trusted");
    expect(result.quotedForumIds).toEqual(["3"]);
    expect(result.quoteSources).toEqual([{ kind: "post", id: "5" }]);
    expect(result.bodyText).toBe("Before\n\nAfter");
    expect(quotes.drafts).toHaveLength(1);
    expect(quotes.drafts[0]).toMatchObject({
      sourceKind: "post",
      sourceId: "5",
      sourceAuthorId: "2",
      bodyMd: "The source says **zebra**",
      bodyHtml: "<p>The source says <strong>zebra</strong></p>",
    });
    expect(quotes.drafts[0]?.renderVersion).toBeGreaterThan(0);
  });

  test("rejects a quote the author cannot read", async () => {
    const quotes = fixture({ sources: [POST], readable: [] });

    await expect(
      renderContent(quote("post:5"), {
        profile: "post",
        context: { kind: "forum_post", forumId: "1" },
        authorId: "7",
        quotes,
      }),
    ).rejects.toMatchObject({ code: "quote_unreadable" });
    expect(quotes.drafts).toHaveLength(0);
  });

  test("rejects a missing source", async () => {
    const quotes = fixture({ sources: [] });

    await expect(
      renderContent(quote("post:99"), {
        profile: "post",
        context: { kind: "forum_post", forumId: "1" },
        authorId: "7",
        quotes,
      }),
    ).rejects.toMatchObject({ code: "quote_unreadable" });
  });

  test("rejects a private message quoted into a forum post", async () => {
    const message: QuoteSource = {
      ref: { kind: "message", id: "8" },
      sourceAuthorId: "2",
      bodyMd: "secret PM",
      contextId: "9",
    };
    const quotes = fixture({ sources: [message] });

    await expect(
      renderContent(quote("message:8"), {
        profile: "post",
        context: { kind: "forum_post", forumId: "1" },
        authorId: "7",
        quotes,
      }),
    ).rejects.toMatchObject({ code: "quote_context_invalid" });
  });

  test("rejects a message from another conversation", async () => {
    const message: QuoteSource = {
      ref: { kind: "message", id: "8" },
      sourceAuthorId: "2",
      bodyMd: "other conversation",
      contextId: "99",
    };
    const quotes = fixture({ sources: [message] });

    await expect(
      renderContent(quote("message:8"), {
        profile: "post",
        context: { kind: "conversation_message", conversationId: "9" },
        authorId: "7",
        quotes,
      }),
    ).rejects.toMatchObject({ code: "quote_context_invalid" });
  });

  test("allows a message from the same conversation", async () => {
    const message: QuoteSource = {
      ref: { kind: "message", id: "8" },
      sourceAuthorId: "2",
      bodyMd: "same conversation",
      contextId: "9",
    };
    const quotes = fixture({ sources: [message] });
    const result = await renderContent(quote("message:8"), {
      profile: "post",
      context: { kind: "conversation_message", conversationId: "9" },
      authorId: "7",
      quotes,
    });

    expect(result.quotedForumIds).toEqual([]);
    expect(result.bodyHtml).toContain('data-source-kind="message"');
  });

  test("creates one snapshot for repeated quotes of the same source", async () => {
    const quotes = fixture({ sources: [POST] });
    const result = await renderContent(`${quote("post:5")}\n\n${quote("post:5")}`, {
      profile: "post",
      context: { kind: "forum_post", forumId: "1" },
      authorId: "7",
      quotes,
    });

    expect(quotes.drafts).toHaveLength(1);
    expect(result.quoteSources).toHaveLength(1);
    expect(result.bodyHtml.match(/data-snapshot="1"/g)).toHaveLength(2);
  });

  test("rejects a malformed quote source", async () => {
    const quotes = fixture({ sources: [POST] });

    await expect(
      renderContent(quote("forum:5"), {
        profile: "post",
        context: { kind: "forum_post", forumId: "1" },
        authorId: "7",
        quotes,
      }),
    ).rejects.toBeInstanceOf(ContentError);
  });
});
