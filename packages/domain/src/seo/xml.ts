/**
 * Sitemap and feed XML serialisation (change `seo-feeds`). Every value is untrusted content
 * or an admin-edited name, so it is escaped on the way out; control characters that XML 1.0
 * forbids are dropped rather than emitted.
 */

export interface SitemapUrl {
  readonly loc: string;
  readonly lastmod?: Date | null;
}

export interface SitemapEntry {
  readonly loc: string;
  readonly lastmod?: Date | null;
}

export interface FeedItem {
  readonly title: string;
  readonly link: string;
  readonly publishedAt: Date;
  readonly updatedAt: Date;
  readonly authorName: string | null;
  readonly excerpt: string;
}

export interface FeedDocument {
  readonly title: string;
  readonly link: string;
  readonly selfLink: string;
  readonly description: string;
  readonly language: string;
  readonly updatedAt: Date;
  readonly authorName: string;
  readonly items: readonly FeedItem[];
}

const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>';

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const FIRST_PRINTABLE = 0x20;
const LAST_SURROGATE_SAFE = 0xd7ff;
const FIRST_PRIVATE = 0xe000;
const LAST_UTF16 = 0xfffd;

/** XML 1.0's allowed character ranges; surrogate pairs are allowed once combined. */
function isXmlCharacter(codePoint: number): boolean {
  return (
    codePoint === TAB ||
    codePoint === LINE_FEED ||
    codePoint === CARRIAGE_RETURN ||
    (codePoint >= FIRST_PRINTABLE && codePoint <= LAST_SURROGATE_SAFE) ||
    (codePoint >= FIRST_PRIVATE && codePoint <= LAST_UTF16) ||
    codePoint >= 0x10000
  );
}

/** Removes characters XML 1.0 cannot represent, then escapes the five markup characters. */
export function escapeXml(value: string): string {
  let clean = "";

  for (const character of value) {
    if (isXmlCharacter(character.codePointAt(0) ?? 0)) {
      clean += character;
    }
  }

  return clean.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

function lastmod(value: Date | null | undefined): string {
  return value === null || value === undefined ? "" : `<lastmod>${value.toISOString()}</lastmod>`;
}

/** A `<urlset>` with one `<url>` per page; 10,000 entries is the caller's page size. */
export function renderSitemapUrlset(urls: readonly SitemapUrl[]): string {
  const entries = urls
    .map((url) => `<url><loc>${escapeXml(url.loc)}</loc>${lastmod(url.lastmod)}</url>`)
    .join("");

  return `${XML_DECLARATION}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

/** The index lists every generated sitemap file so crawlers can find the pages. */
export function renderSitemapIndex(entries: readonly SitemapEntry[]): string {
  const sitemaps = entries
    .map(
      (entry) => `<sitemap><loc>${escapeXml(entry.loc)}</loc>${lastmod(entry.lastmod)}</sitemap>`,
    )
    .join("");

  return `${XML_DECLARATION}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemaps}</sitemapindex>`;
}

function rssItem(item: FeedItem): string {
  const author =
    item.authorName === null ? "" : `<dc:creator>${escapeXml(item.authorName)}</dc:creator>`;

  return [
    "<item>",
    `<title>${escapeXml(item.title)}</title>`,
    `<link>${escapeXml(item.link)}</link>`,
    `<guid isPermaLink="true">${escapeXml(item.link)}</guid>`,
    author,
    `<pubDate>${item.publishedAt.toUTCString()}</pubDate>`,
    `<description>${escapeXml(item.excerpt)}</description>`,
    "</item>",
  ].join("");
}

/** RSS 2.0; `dc:creator` carries the display name (the core `author` element expects an email). */
export function renderRssFeed(feed: FeedDocument): string {
  const items = feed.items.map(rssItem).join("");

  return [
    XML_DECLARATION,
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" ',
    'xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "<channel>",
    `<title>${escapeXml(feed.title)}</title>`,
    `<link>${escapeXml(feed.link)}</link>`,
    `<description>${escapeXml(feed.description)}</description>`,
    `<language>${escapeXml(feed.language)}</language>`,
    `<lastBuildDate>${feed.updatedAt.toUTCString()}</lastBuildDate>`,
    `<atom:link href="${escapeXml(feed.selfLink)}" rel="self" type="application/rss+xml"/>`,
    items,
    "</channel>",
    "</rss>",
  ].join("");
}

function atomItem(item: FeedItem): string {
  const author =
    item.authorName === null ? "" : `<author><name>${escapeXml(item.authorName)}</name></author>`;

  return [
    "<entry>",
    `<title>${escapeXml(item.title)}</title>`,
    `<link rel="alternate" href="${escapeXml(item.link)}"/>`,
    `<id>${escapeXml(item.link)}</id>`,
    `<published>${item.publishedAt.toISOString()}</published>`,
    `<updated>${item.updatedAt.toISOString()}</updated>`,
    author,
    `<summary type="text">${escapeXml(item.excerpt)}</summary>`,
    "</entry>",
  ].join("");
}

/** Atom 1.0. The feed-level author covers entries whose member name is no longer public. */
export function renderAtomFeed(feed: FeedDocument): string {
  const items = feed.items.map(atomItem).join("");

  return [
    XML_DECLARATION,
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<title>${escapeXml(feed.title)}</title>`,
    `<id>${escapeXml(feed.selfLink)}</id>`,
    `<link rel="self" href="${escapeXml(feed.selfLink)}"/>`,
    `<link rel="alternate" href="${escapeXml(feed.link)}"/>`,
    `<updated>${feed.updatedAt.toISOString()}</updated>`,
    `<author><name>${escapeXml(feed.authorName)}</name></author>`,
    items,
    "</feed>",
  ].join("");
}

/** Collapses layout whitespace, then keeps the first 300 characters of quote-free text. */
export const FEED_EXCERPT_LENGTH = 300;

export function feedExcerpt(bodyText: string): string {
  return bodyText.replace(/\s+/g, " ").trim().slice(0, FEED_EXCERPT_LENGTH).trimEnd();
}
