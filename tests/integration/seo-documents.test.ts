import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  topicsSeedModule,
} from "@bulletin/db/seed";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { feedDocumentFor } from "../../apps/user-app/src/seo/feeds.ts";
import {
  type SitemapKind,
  sitemapIndexDocument,
  sitemapPageDocument,
} from "../../apps/user-app/src/seo/sitemaps.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const ORIGIN = "http://board.test:18080";

type XmlNode = Readonly<Record<string, unknown>>;

function node(value: unknown): XmlNode {
  return typeof value === "object" && value !== null ? (value as XmlNode) : {};
}

function list(value: unknown): readonly XmlNode[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is XmlNode => typeof entry === "object" && entry !== null);
  }

  return typeof value === "object" && value !== null ? [value as XmlNode] : [];
}

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const inner = (value as { readonly "#text"?: unknown })["#text"];
    return typeof inner === "string" ? inner : "";
  }

  return "";
}

function parse(xml: string): XmlNode {
  return node(Bun.XML.parse(xml));
}

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "seo_documents" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        topicsSeedModule,
      ]),
    });
    await run(database);
  });
}

function sitemapPath(loc: string): { readonly kind: SitemapKind; readonly page: number } | null {
  const match = /\/sitemap\/(forums|topics|members)\/(\d+)\.xml$/.exec(loc);

  if (match === null) {
    return null;
  }

  return { kind: match[1] as SitemapKind, page: Number(match[2]) };
}

integrationDescribe("generated XML documents", () => {
  test("the seeded board produces well-formed sitemap index and pages", async () => {
    await withSeededDb(async (database) => {
      const index = await sitemapIndexDocument({ sql: database.sql, origin: ORIGIN });
      const indexXml = parse(index.body);
      const sitemapIndex = node(indexXml.sitemapindex);

      expect(sitemapIndex["@xmlns"]).toBe("http://www.sitemaps.org/schemas/sitemap/0.9");

      const entries = list(sitemapIndex.sitemap);
      expect(entries.length).toBeGreaterThan(0);

      const seen = new Set<string>();

      for (const entry of entries) {
        const loc = text(entry.loc);
        const target = sitemapPath(loc);

        expect(loc).toStartWith(`${ORIGIN}/sitemap/`);
        expect(target).not.toBeNull();

        if (target === null) {
          continue;
        }

        const page = await sitemapPageDocument({
          sql: database.sql,
          origin: ORIGIN,
          kind: target.kind,
          page: target.page,
        });
        expect(page.status).toBe(200);

        const pageXml = parse(page.body);
        const urlset = node(pageXml.urlset);

        expect(urlset["@xmlns"]).toBe("http://www.sitemaps.org/schemas/sitemap/0.9");

        for (const url of list(urlset.url)) {
          const urlLoc = text(url.loc);

          expect(urlLoc).toStartWith(ORIGIN);
          seen.add(urlLoc);

          if (typeof url.lastmod === "string") {
            expect(Number.isNaN(Date.parse(url.lastmod))).toBe(false);
          }
        }
      }

      expect(seen.size).toBeGreaterThan(0);
      expect([...seen]).toContain(`${ORIGIN}/forum/2-announcements`);
      expect([...seen].some((url) => url.includes("/topic/"))).toBe(true);
      expect([...seen].some((url) => url.includes("/profile/"))).toBe(true);
    });
  }, 60_000);

  test("the seeded board produces well-formed RSS and Atom feeds", async () => {
    await withSeededDb(async (database) => {
      const rss = await feedDocumentFor({ sql: database.sql, origin: ORIGIN, format: "rss" });
      const atom = await feedDocumentFor({ sql: database.sql, origin: ORIGIN, format: "atom" });
      const forumRss = await feedDocumentFor({
        sql: database.sql,
        origin: ORIGIN,
        format: "rss",
        forumRef: "2-announcements",
      });

      const rssXml = node(parse(rss.body).rss);
      expect(rssXml["@version"]).toBe("2.0");

      const channel = node(rssXml.channel);
      expect(text(channel.title)).toContain("Bulletin");
      expect(text(channel.link)).toBe(`${ORIGIN}/`);
      expect(Number.isNaN(Date.parse(text(channel.lastBuildDate)))).toBe(false);

      const items = list(channel.item);
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThanOrEqual(20);

      for (const item of items) {
        expect(text(item.title).length).toBeGreaterThan(0);
        expect(text(item.link)).toStartWith(`${ORIGIN}/topic/`);
        expect(text(item.guid)).toBe(text(item.link));
        expect(text(item.pubDate).length).toBeGreaterThan(0);
        expect(text(item.description).length).toBeGreaterThan(0);
      }

      const atomXml = node(parse(atom.body).feed);
      expect(atomXml["@xmlns"]).toBe("http://www.w3.org/2005/Atom");
      expect(list(atomXml.entry).length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(text(atomXml.updated)))).toBe(false);

      const forumXml = node(parse(forumRss.body).rss);
      const forumChannel = node(forumXml.channel);
      expect(text(forumChannel.link)).toStartWith(`${ORIGIN}/forum/2-announcements`);
      expect(list(forumChannel.item).length).toBeGreaterThan(0);
    });
  }, 60_000);
});
