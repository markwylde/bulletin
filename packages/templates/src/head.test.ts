import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import {
  createCompileCache,
  createTemplateEngine,
  enforceHeadMarkup,
  HEAD_TEMPLATE_NAME,
  loadDefaultThemeTemplates,
  renderThemeTemplate,
  type TemplateRuntime,
  type ThemeHeadSeo,
  validateHeadTemplate,
} from "./index.ts";
import { buildTheme } from "./theme-fixtures.ts";

const runtime: TemplateRuntime = { translate: createServerT("en"), hooks: {} };
const ORIGIN = "https://board.test";
const SEO: ThemeHeadSeo = {
  title: 'Tom & "Jerry" <script>alert(1)</script> · Bulletin',
  description: 'A <b>bold</b> & quoted "description".',
  canonical: `${ORIGIN}/topic/7-tom/page/2?lang=es`,
  robots: "noindex",
  type: "article",
  locale: "es",
  alternates: [
    { hreflang: "en", href: `${ORIGIN}/topic/7-tom/page/2` },
    { hreflang: "es", href: `${ORIGIN}/topic/7-tom/page/2?lang=es` },
    { hreflang: "fr", href: `${ORIGIN}/topic/7-tom/page/2?lang=fr` },
    { hreflang: "x-default", href: `${ORIGIN}/topic/7-tom/page/2` },
  ],
};

async function renderHead(childHead: string | null): Promise<string> {
  const templates = await loadDefaultThemeTemplates();
  const engine = createTemplateEngine({ islands: {} });
  const theme = buildTheme([
    { name: "child", templates: childHead === null ? {} : { head: childHead } },
    { name: "default", source: "core", templates: { head: templates.head ?? "" } },
  ]);
  const rendered = await renderThemeTemplate({
    engine,
    compiled: createCompileCache(engine).compile(theme, 1),
    name: HEAD_TEMPLATE_NAME,
    viewModel: { seo: SEO, boardName: "Bulletin" },
    runtime,
  });

  return rendered.html;
}

function tags(html: string, pattern: RegExp): readonly string[] {
  return html.match(new RegExp(pattern.source, "g")) ?? [];
}

describe("default theme head template", () => {
  test("renders every required tag, autoescaped, and passes the required-meta check", async () => {
    const html = await renderHead(null);
    const enforced = enforceHeadMarkup(html, SEO);

    expect(enforced.problems).toEqual([]);
    expect(enforced.html).not.toContain("<script>");
    expect(enforced.html).toContain(
      '<title>Tom &amp; "Jerry" &lt;script&gt;alert(1)&lt;/script&gt; · Bulletin</title>',
    );
    expect(enforced.html).toContain('<meta name="robots" content="noindex">');
    expect(enforced.html).toContain(`<link rel="canonical" href="${SEO.canonical}">`);
    expect(enforced.html).toContain(
      `<link rel="alternate" hreflang="fr" href="${ORIGIN}/topic/7-tom/page/2?lang=fr">`,
    );
    expect(enforced.html).toContain(`<meta property="og:url" content="${SEO.canonical}">`);
    expect(enforced.html).toContain('<meta name="twitter:card" content="summary">');
    expect(enforced.html).toContain('content="A &lt;b&gt;bold&lt;/b&gt; &amp; quoted &quot;');
    expect(tags(enforced.html, /<link rel="alternate"/)).toHaveLength(4);
  });

  test("passes the save-time check", async () => {
    const templates = await loadDefaultThemeTemplates();

    expect(validateHeadTemplate(templates.head ?? "")).toEqual([]);
  });
});

describe("theme head overrides", () => {
  test("a theme restyles presentation and keeps its own extra metadata", async () => {
    const html = await renderHead(
      [
        "<title>{{ seo.title }} | custom</title>",
        '<meta name="robots" content="{{ seo.robots }}">',
        '<link rel="canonical" href="{{ seo.canonical }}">',
        '<meta name="theme-color" content="#123456">',
        '<meta property="og:title" content="{{ seo.title }}">',
      ].join("\n"),
    );
    const enforced = enforceHeadMarkup(html, SEO);

    expect(enforced.html).toContain("| custom</title>");
    expect(enforced.html).toContain('<meta name="theme-color" content="#123456">');
    // The theme left out hreflang; the check adds the trusted set.
    expect(tags(enforced.html, /<link rel="alternate"/)).toHaveLength(4);
    expect(enforced.html).not.toContain("twitter:card");
  });

  test("a theme that omits robots and canonical gets the trusted tags", async () => {
    const enforced = enforceHeadMarkup(
      await renderHead('<meta property="og:title" content="{{ seo.title }}">'),
      SEO,
    );

    expect(tags(enforced.html, /<title>/)).toHaveLength(1);
    expect(tags(enforced.html, /<meta name="robots"/)).toEqual(['<meta name="robots"']);
    expect(enforced.html).toContain('<meta name="robots" content="noindex">');
    expect(enforced.html).toContain(`<link rel="canonical" href="${SEO.canonical}">`);
    expect(enforced.problems).toContain("added missing title, robots, canonical");
  });

  test("a theme cannot make a noindex page indexable or move its canonical", async () => {
    const enforced = enforceHeadMarkup(
      await renderHead(
        [
          "<title>{{ seo.title }}</title>",
          '<meta name="robots" content="index, follow">',
          '<link rel="canonical" href="https://elsewhere.example/">',
          '<meta property="og:url" content="https://elsewhere.example/">',
          '<link rel="alternate" hreflang="de" href="https://elsewhere.example/de">',
        ].join("\n"),
      ),
      SEO,
    );

    expect(enforced.html).not.toContain("elsewhere.example");
    expect(enforced.html).not.toContain("index, follow");
    expect(enforced.html).toContain('<meta name="robots" content="noindex">');
    expect(tags(enforced.html, /<link rel="canonical"/)).toHaveLength(1);
    expect(enforced.html).toContain(`<link rel="canonical" href="${SEO.canonical}">`);
    expect(enforced.problems).toEqual(
      expect.arrayContaining([
        "replaced the robots directive",
        "replaced the canonical link",
        "removed an og:url that is not the canonical URL",
        "removed an alternate link that is not a locale variant",
      ]),
    );
  });

  test("only head metadata survives: scripts, refreshes, stylesheets and body markup go", () => {
    const enforced = enforceHeadMarkup(
      [
        "<title>Mine</title>",
        "<title>Second</title>",
        "<script>alert(1)</script>",
        '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
        '<meta charset="latin1">',
        '<link rel="stylesheet" href="https://evil.example/x.css">',
        '<base href="https://evil.example/">',
        "<div>body content</div>",
        '<meta name="robots" content="noindex">',
        '<meta name="robots" content="noindex">',
      ].join(""),
      SEO,
    );

    expect(enforced.html).toContain("<title>Mine</title>");
    expect(enforced.html).not.toContain("Second");
    expect(enforced.html).not.toContain("evil.example");
    expect(enforced.html).not.toContain("<script");
    expect(enforced.html).not.toContain("<div");
    expect(enforced.html).not.toContain("latin1");
    expect(tags(enforced.html, /<meta name="robots"/)).toHaveLength(1);
  });

  test("an empty render (a failed template) falls back to every trusted tag", () => {
    const enforced = enforceHeadMarkup("", SEO);

    expect(enforced.html).toContain('<title>Tom &amp; "Jerry" &lt;script&gt;');
    expect(enforced.html).toContain('<meta name="robots" content="noindex">');
    expect(enforced.html).toContain(`<link rel="canonical" href="${SEO.canonical}">`);
    expect(tags(enforced.html, /<link rel="alternate"/)).toHaveLength(4);
  });
});

describe("head template save-time check", () => {
  test("requires title, robots and canonical and rejects non-head elements", () => {
    expect(validateHeadTemplate('<meta property="og:title" content="{{ seo.title }}">')).toEqual(
      expect.arrayContaining([
        { code: "missing_meta", meta: "title" },
        { code: "missing_meta", meta: "robots" },
        { code: "missing_meta", meta: "canonical" },
      ]),
    );
    expect(
      validateHeadTemplate(
        [
          "<title>{{ seo.title }}</title>",
          '<meta name="robots" content="{{ seo.robots }}">',
          '<link rel="canonical" href="{{ seo.canonical }}">',
          '<link rel="stylesheet" href="/x.css">',
          "<div>{{ seo.title }}</div>",
        ].join("\n"),
      ),
    ).toEqual([
      { code: "head_element", element: "link" },
      { code: "head_element", element: "div" },
    ]);
  });
});
