import { describe, expect, test } from "bun:test";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 3.2: the seeded, running board serves well-formed sitemaps and feeds.

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

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
  return typeof value === "string" ? value : "";
}

async function fetchXml(path: string): Promise<{ response: Response; xml: XmlNode }> {
  const response = await fetch(`${USER_URL}${path}`);
  const body = await response.text();

  return { response, xml: node(Bun.XML.parse(body)) };
}

integrationDescribe("live SEO documents", () => {
  test("sitemap index and every advertised file parse as XML", async () => {
    const { response, xml } = await fetchXml("/sitemap.xml");
    const index = node(xml.sitemapindex);

    expect(response.status).toBe(200);
    expect(index["@xmlns"]).toBe("http://www.sitemaps.org/schemas/sitemap/0.9");

    const entries = list(index.sitemap);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const loc = text(entry.loc);
      expect(loc).toStartWith(`${USER_URL}/sitemap/`);

      const url = new URL(loc);
      const page = await fetch(`${url.origin}${url.pathname}`);
      const pageXml = node(Bun.XML.parse(await page.text())).urlset;

      expect(page.status).toBe(200);
      expect(node(pageXml)["@xmlns"]).toBe("http://www.sitemaps.org/schemas/sitemap/0.9");
      expect(list(node(pageXml).url).length).toBeGreaterThan(0);
    }
  }, 60_000);

  test("board and forum RSS/Atom feeds parse with the required feed fields", async () => {
    const rss = await fetchXml("/feed.xml");
    const channel = node(node(rss.xml.rss).channel);

    expect(rss.response.status).toBe(200);
    expect(node(rss.xml.rss)["@version"]).toBe("2.0");
    expect(text(channel.title).length).toBeGreaterThan(0);
    expect(list(channel.item).length).toBeGreaterThan(0);

    const atom = await fetchXml("/feed.atom");
    const feed = node(atom.xml.feed);

    expect(atom.response.status).toBe(200);
    expect(feed["@xmlns"]).toBe("http://www.w3.org/2005/Atom");
    expect(list(feed.entry).length).toBeGreaterThan(0);

    const forum = await fetchXml("/feed/forum/2-announcements.xml");
    const forumChannel = node(node(forum.xml.rss).channel);

    expect(forum.response.status).toBe(200);
    expect(text(forumChannel.link)).toContain("/forum/2-announcements");
    expect(list(forumChannel.item).length).toBeGreaterThan(0);
  }, 60_000);
});
