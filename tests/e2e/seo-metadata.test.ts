import { describe, expect, test } from "bun:test";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 2.1: metadata and noindex rules on public pages.

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

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
});
