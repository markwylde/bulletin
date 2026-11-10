import { describe, expect, test } from "bun:test";
import { type QuoteSnapshotView, resolveQuotePlaceholders } from "./quote-view.ts";
import type { QuoteSourceRef } from "./types.ts";
import { currentContentVersions } from "./versioning.ts";

const MESSAGES: Record<string, string> = {
  "content.quote.unavailable": "Quoted content unavailable",
  "content.quote.redacted": "This quote was edited by a moderator",
  "content.quote.viewSource": "View post",
};

function translate(key: string): string {
  return MESSAGES[key] ?? key;
}

function placeholder(options: {
  readonly source?: string;
  readonly snapshot?: string;
  readonly kind?: string;
}): string {
  return `<p>before</p><bl-quote data-source-kind="${options.kind ?? "post"}" data-source="${
    options.source ?? "5"
  }" data-snapshot="${options.snapshot ?? "11"}"></bl-quote><p>after</p>`;
}

function snapshot(overrides: Partial<QuoteSnapshotView> = {}): QuoteSnapshotView {
  const versions = currentContentVersions();

  return {
    id: "11",
    sourceKind: "post",
    sourceId: "5",
    sourceAuthorId: "2",
    bodyHtml: "<p>private text</p>",
    renderVersion: versions.renderVersion,
    sanitiserVersion: versions.sanitiserVersion,
    redactedAt: null,
    ...overrides,
  };
}

function resolver(options: {
  readonly snapshot?: QuoteSnapshotView | null;
  readonly readable?: boolean;
}) {
  return {
    async loadSnapshot(): Promise<QuoteSnapshotView | null> {
      return options.snapshot === undefined ? snapshot() : options.snapshot;
    },
    async canRead(_ref: QuoteSourceRef, _viewerId: string | null): Promise<boolean> {
      return options.readable ?? true;
    },
    sourceUrl(): string | null {
      return "/topic/3-post/5";
    },
  };
}

describe("quote resolution per viewer", () => {
  test("shows the snapshot only to viewers who can read the source", async () => {
    const guest = await resolveQuotePlaceholders(placeholder({}), {
      resolver: resolver({ readable: false }),
      viewerId: null,
      translate,
    });
    const staff = await resolveQuotePlaceholders(placeholder({}), {
      resolver: resolver({ readable: true }),
      viewerId: "1",
      translate,
    });

    expect(guest).toContain("Quoted content unavailable");
    expect(guest).not.toContain("private text");
    expect(staff).toContain("private text");
    expect(staff).toContain('href="/topic/3-post/5"');
  });

  test("renders the redaction notice instead of a redacted snapshot", async () => {
    const html = await resolveQuotePlaceholders(placeholder({}), {
      resolver: resolver({ snapshot: snapshot({ redactedAt: new Date() }) }),
      viewerId: "1",
      translate,
    });

    expect(html).toContain("This quote was edited by a moderator");
    expect(html).not.toContain("private text");
    expect(html).toContain('href="/topic/3-post/5"');
  });

  test("keeps the original snapshot when redaction is off", async () => {
    const html = await resolveQuotePlaceholders(placeholder({}), {
      resolver: resolver({ snapshot: snapshot() }),
      viewerId: "1",
      translate,
    });

    expect(html).toContain("private text");
    expect(html).not.toContain("This quote was edited by a moderator");
  });

  test("hides a snapshot whose source no longer resolves", async () => {
    const html = await resolveQuotePlaceholders(placeholder({}), {
      resolver: resolver({ snapshot: null }),
      viewerId: "1",
      translate,
    });

    expect(html).toContain("Quoted content unavailable");
  });

  test("hides a snapshot that belongs to a different source", async () => {
    const html = await resolveQuotePlaceholders(placeholder({ source: "5", snapshot: "11" }), {
      resolver: resolver({ snapshot: snapshot({ sourceId: "99" }) }),
      viewerId: "1",
      translate,
    });

    expect(html).toContain("Quoted content unavailable");
    expect(html).not.toContain("private text");
  });

  test("re-sanitises a stale snapshot before showing it", async () => {
    const html = await resolveQuotePlaceholders(placeholder({}), {
      resolver: resolver({
        snapshot: snapshot({
          sanitiserVersion: 0,
          bodyHtml: '<p>old</p><img src=x onerror="alert(1)">',
        }),
      }),
      viewerId: "1",
      translate,
    });

    expect(html).toContain("<p>old</p>");
    expect(html).not.toContain("onerror");
  });

  test("resolves several placeholders in order", async () => {
    const html = await resolveQuotePlaceholders(
      `${placeholder({ snapshot: "1" })}
       ${placeholder({ snapshot: "2" })}`,
      {
        resolver: {
          async loadSnapshot(id) {
            return snapshot({ id, bodyHtml: `<p>snapshot ${id}</p>` });
          },
          async canRead() {
            return true;
          },
          sourceUrl() {
            return "/topic/3-post/5";
          },
        },
        viewerId: "1",
        translate,
      },
    );

    expect(html.indexOf("snapshot 1")).toBeLessThan(html.indexOf("snapshot 2"));
  });

  test("does not touch HTML without quote placeholders", async () => {
    const html = "<p>plain</p>";

    expect(
      await resolveQuotePlaceholders(html, {
        resolver: resolver({}),
        viewerId: null,
        translate,
      }),
    ).toBe(html);
  });
});
