import { describe, expect, test } from "bun:test";
import {
  escapeXml,
  FEED_EXCERPT_LENGTH,
  feedExcerpt,
  renderAtomFeed,
  renderRssFeed,
  renderSitemapIndex,
  renderSitemapUrlset,
} from "./xml.ts";

const FEED = {
  title: "Board & <news>",
  link: "http://board.example/",
  selfLink: "http://board.example/feed.xml?a=1&b=2",
  description: "Recent topics",
  language: "en",
  updatedAt: new Date("2026-11-14T10:00:00Z"),
  authorName: "Board",
  items: [
    {
      title: "Cats < dogs",
      link: "http://board.example/topic/1-cats",
      publishedAt: new Date("2026-11-13T09:00:00Z"),
      updatedAt: new Date("2026-11-14T09:00:00Z"),
      authorName: "Jane & co",
      excerpt: "A & B < C",
    },
  ],
};

describe("sitemap and feed XML", () => {
  test("escapes markup and drops characters XML 1.0 forbids", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;",
    );
    expect(escapeXml("a\u0000b\u0008c\u001fd")).toBe("abcd");
  });

  test("renders a urlset with escaped locations and ISO lastmod dates", () => {
    const xml = renderSitemapUrlset([
      {
        loc: "http://board.example/topic/1-a&b",
        lastmod: new Date("2026-11-14T09:30:00Z"),
      },
    ]);

    expect(xml).toStartWith('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>http://board.example/topic/1-a&amp;b</loc>");
    expect(xml).toContain("<lastmod>2026-11-14T09:30:00.000Z</lastmod>");
  });

  test("renders a sitemap index with one sitemap per file", () => {
    const xml = renderSitemapIndex([
      { loc: "http://board.example/sitemap/forums/1.xml" },
      { loc: "http://board.example/sitemap/topics/1.xml" },
    ]);

    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.match(/<sitemap>/g)).toHaveLength(2);
  });

  test("renders RSS 2.0 with creator, date and an escaped description", () => {
    const xml = renderRssFeed(FEED);

    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain("<title>Board &amp; &lt;news&gt;</title>");
    expect(xml).toContain("<dc:creator>Jane &amp; co</dc:creator>");
    expect(xml).toContain("<pubDate>Fri, 13 Nov 2026 09:00:00 GMT</pubDate>");
    expect(xml).toContain("<description>A &amp; B &lt; C</description>");
    expect(xml).toContain('<atom:link href="http://board.example/feed.xml?a=1&amp;b=2" rel="self"');
  });

  test("renders Atom 1.0 entries with escaped ids and summaries", () => {
    const xml = renderAtomFeed(FEED);

    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<id>http://board.example/topic/1-cats</id>");
    expect(xml).toContain('<summary type="text">A &amp; B &lt; C</summary>');
    expect(xml).toContain("<updated>2026-11-14T09:00:00.000Z</updated>");
    expect(xml).toContain("<published>2026-11-13T09:00:00.000Z</published>");
  });

  test("excerpts collapse whitespace and stop at 300 characters", () => {
    expect(feedExcerpt("  one\n\n two\t three  ")).toBe("one two three");

    const long = "x".repeat(FEED_EXCERPT_LENGTH + 20);
    expect(feedExcerpt(long)).toHaveLength(FEED_EXCERPT_LENGTH);
  });
});
