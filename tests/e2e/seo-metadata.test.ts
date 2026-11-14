import { describe, expect, test } from "bun:test";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 2.1: metadata and noindex rules on public pages.

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const CDN = `${USER_URL}/_mocks/cdn`;

function head(html: string): string {
  return html.slice(0, html.indexOf("</head>"));
}

function tagContent(html: string, pattern: RegExp): string | undefined {
  return pattern.exec(html)?.[1];
}

integrationDescribe("SEO metadata", () => {
  test("public pages carry title, description, canonical, OpenGraph, Twitter and hreflang", async () => {
    const home = await fetch(USER_URL);
    const html = await home.text();
    const origin = new URL(USER_URL).origin;

    expect(home.status).toBe(200);
    expect(html).toContain(`<link rel="canonical" href="${origin}/"`);
    expect(html).toContain('<meta property="og:title"');
    expect(html).toContain(`<meta property="og:url" content="${origin}/"`);
    expect(html).toContain('<meta name="twitter:card" content="summary"');
    expect(html).toContain(`hreflang="es" href="${origin}/?lang=es"`);
    expect(html).toContain('<meta name="robots" content="index"');
    expect(html).toContain('<meta name="description" content="');
  }, 60_000);

  test("member lists and search results are noindex", async () => {
    const members = await fetch(`${USER_URL}/members`);
    const search = await fetch(`${USER_URL}/search?q=bulletin`);
    const membersHtml = await members.text();
    const searchHtml = await search.text();

    expect(members.status).toBe(200);
    expect(membersHtml).toContain('<meta name="robots" content="noindex"');
    expect(search.status).toBe(200);
    expect(searchHtml).toContain('<meta name="robots" content="noindex"');
    expect(searchHtml).toContain('<link rel="canonical"');
    expect(searchHtml).toContain('/search"');
  }, 60_000);
  test("topic pages carry canonical and discussion JSON-LD", async () => {
    const forum = await fetch(`${USER_URL}/forum/2-announcements`);
    const forumHtml = await forum.text();
    const topicPath = /\/topic\/\d+-[a-z0-9-]+/.exec(forumHtml)?.[0];

    expect(topicPath).toBeDefined();

    if (topicPath === undefined) {
      throw new Error("The announcements page listed no topic");
    }

    const topic = await fetch(`${USER_URL}${topicPath}`);
    const topicHtml = await topic.text();

    expect(topic.status).toBe(200);
    expect(topicHtml).toContain(`<link rel="canonical" href="${USER_URL}${topicPath}"`);
    expect(topicHtml).toContain('<meta name="robots" content="index"');
    expect(topicHtml).toContain('type="application/ld+json"');
    expect(topicHtml).toContain('"@type":"DiscussionForumPosting"');
  }, 60_000);

  test("hreflang alternates serve their locale with self-canonical metadata", async () => {
    const origin = new URL(USER_URL).origin;
    const english = await fetch(`${USER_URL}/members`);
    const spanish = await fetch(`${USER_URL}/members?lang=es`);
    const french = await fetch(`${USER_URL}/members?lang=fr&utm_source=feed`);
    const englishHead = head(await english.text());
    const spanishHead = head(await spanish.text());
    const frenchHead = head(await french.text());

    expect(english.status).toBe(200);
    expect(spanish.status).toBe(200);
    expect(french.status).toBe(200);

    // Each locale's own page and metadata, not the English page with a client-side swap.
    expect(englishHead).toContain('<html lang="en"');
    expect(tagContent(englishHead, /<title>([^<]*)<\/title>/)).toStartWith("Members");
    expect(spanishHead).toContain('<html lang="es"');
    expect(tagContent(spanishHead, /<title>([^<]*)<\/title>/)).toStartWith("Miembros");
    expect(spanishHead).toContain(
      '<meta name="description" content="Explora los miembros de esta comunidad."',
    );
    expect(frenchHead).toContain('<html lang="fr"');
    expect(tagContent(frenchHead, /<title>([^<]*)<\/title>/)).toStartWith("Membres");

    // The clean URL is the board default; every other variant is self-canonical.
    expect(englishHead).toContain(`<link rel="canonical" href="${origin}/members"`);
    expect(spanishHead).toContain(`<link rel="canonical" href="${origin}/members?lang=es"`);
    expect(frenchHead).toContain(`<link rel="canonical" href="${origin}/members?lang=fr"`);

    for (const page of [englishHead, spanishHead, frenchHead]) {
      expect(page).toContain(`hreflang="en" href="${origin}/members"`);
      expect(page).toContain(`hreflang="es" href="${origin}/members?lang=es"`);
      expect(page).toContain(`hreflang="fr" href="${origin}/members?lang=fr"`);
      expect(page).toContain(`hreflang="x-default" href="${origin}/members"`);
    }

    // `?lang=` never becomes the guest's saved preference.
    expect(spanish.headers.get("set-cookie") ?? "").not.toContain("bp=");
  }, 60_000);

  test("the CDN keeps locale alternates and the clean URL apart", async () => {
    const purge = await fetch(`${CDN}/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["board", "perm", "member_directory"] }),
    });
    expect(purge.status).toBe(200);

    const clean = await fetch(`${CDN}/members`);
    const cleanHtml = await clean.text();
    const spanish = await fetch(`${CDN}/members?lang=es`);
    const spanishHtml = await spanish.text();
    const cleanAgain = await fetch(`${CDN}/members`);
    const cleanAgainHtml = await cleanAgain.text();

    expect(clean.headers.get("cache-control")).toContain("public");
    expect(spanish.headers.get("x-cache")).toBe("MISS");
    expect(spanishHtml).toContain('<html lang="es"');
    expect(cleanAgain.headers.get("x-cache")).toBe("HIT");
    expect(cleanAgainHtml).toContain('<html lang="en"');
    expect(cleanAgainHtml).not.toContain("Miembros");
    expect(cleanHtml).toBe(cleanAgainHtml);
  }, 60_000);
});
