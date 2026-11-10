import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import { parseFragment } from "parse5";
import {
  createCompileCache,
  createTemplateEngine,
  renderThemeTemplate,
  safeHtml,
  sanitiseRenderedMarkup,
  type TemplateRuntime,
} from "./index.ts";
import { buildTheme } from "./theme-fixtures.ts";

const runtime: TemplateRuntime = { translate: createServerT("en"), hooks: {} };

describe("sanitiseRenderedMarkup", () => {
  test("removes scripts, frames, objects, embeds, base and meta refresh", () => {
    const result = sanitiseRenderedMarkup(
      '<p>ok</p><script>alert(1)</script><iframe src="/x"></iframe>' +
        '<object data="/x"></object><embed src="/x">' +
        '<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=/x">',
    );

    expect(result.html).toBe("<p>ok</p>");
    expect([...result.removed].sort()).toEqual([
      "the base element",
      "the embed element",
      "the http-equiv refresh meta tag",
      "the iframe element",
      "the object element",
      "the script element",
    ]);
  });

  test("keeps a content-pipeline player only on an allowlisted provider origin", () => {
    const player =
      '<div class="embed embed-youtube"><iframe data-bl-embed="youtube" ' +
      'src="https://www.youtube-nocookie.com/embed/abc" title="YouTube" loading="lazy" ' +
      'allowfullscreen srcdoc="<script>alert(1)</script>"></iframe></div>';
    const result = sanitiseRenderedMarkup(player, {
      trustedFrameOrigins: ["https://www.youtube-nocookie.com"],
    });

    expect(result.html).toContain('<iframe data-bl-embed="youtube"');
    expect(result.html).toContain('src="https://www.youtube-nocookie.com/embed/abc"');
    expect(result.html).not.toContain("srcdoc");
    expect(result.removed).toEqual(["the srcdoc attribute on iframe"]);
  });

  test("removes unmarked iframes and players on an untrusted origin", () => {
    const unmarked = sanitiseRenderedMarkup(
      '<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>',
      { trustedFrameOrigins: ["https://www.youtube-nocookie.com"] },
    );
    const offOrigin = sanitiseRenderedMarkup(
      '<iframe data-bl-embed="youtube" src="https://evil.example/embed/abc"></iframe>',
      { trustedFrameOrigins: ["https://www.youtube-nocookie.com"] },
    );

    expect(unmarked.html).toBe("");
    expect(unmarked.removed).toEqual(["the iframe element"]);
    expect(offOrigin.html).toBe("");
    expect(offOrigin.removed).toEqual(["the iframe element"]);
  });

  test("strips event handlers and forbidden URL schemes but keeps the element", () => {
    const result = sanitiseRenderedMarkup(
      '<div onclick="steal()" data-x="1">' +
        '<a href="javascript:alert(1)">a</a>' +
        '<img src="data:image/png;base64,AAAA" alt="">' +
        '<video poster="vbscript:x"></video></div>',
    );

    expect(result.html).toContain('<div data-x="1">');
    expect(result.html).not.toContain("onclick");
    expect(result.html).not.toContain("javascript:");
    expect(result.html).not.toContain("data:image");
    expect(result.html).not.toContain("vbscript:");
    expect([...result.removed].sort()).toEqual([
      "the href attribute on a",
      "the onclick attribute on div",
      "the poster attribute on video",
      "the src attribute on img",
    ]);
  });

  test("strips form targets a browser resolves off origin", () => {
    const payloads = [
      '<form action="/\\evil.example/collect"></form>',
      '<form action="//evil.example/collect"></form>',
      '<form action="/&#x09;/evil.example/collect"></form>',
    ];

    for (const payload of payloads) {
      const result = sanitiseRenderedMarkup(payload);

      expect(result.html).not.toContain("evil.example");
      expect(result.removed).toContain("the action attribute on form");
    }
  });

  test("removes a noscript element whichever way a browser parses it", () => {
    const payload = '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>';
    const result = sanitiseRenderedMarkup(payload);

    expect(result.html).toBe("");
    expect(result.removed).toEqual(["the noscript element"]);

    // A scripting-enabled parser reads the same bytes as raw text; with the element gone it
    // must not find an image or an event handler either way.
    const browser = JSON.stringify(parseFragment(result.html, { scriptingEnabled: true }));

    expect(browser).not.toContain("onerror");
    expect(browser).not.toContain('"img"');
  });

  test("strips off-origin form targets and keeps same-origin ones", () => {
    const result = sanitiseRenderedMarkup(
      '<form action="https://evil.test/steal"><button formaction="//evil.test">x</button></form>' +
        '<form action="/topic/1/reply"></form>',
    );

    expect(result.html).toContain('<form action="/topic/1/reply">');
    expect(result.html).not.toContain("evil.test");
    expect([...result.removed].sort()).toEqual([
      "the action attribute on form",
      "the formaction attribute on button",
    ]);
  });

  test("returns the input unchanged when nothing is removed", () => {
    const html = '<bl-island data-name="X" data-props="{&quot;a&quot;:1}"><p>ok</p></bl-island>';

    expect(sanitiseRenderedMarkup(html)).toEqual({ html, removed: [] });
  });

  test("inspects noscript and template content", () => {
    const result = sanitiseRenderedMarkup(
      "<noscript><script>x</script></noscript><template><iframe></iframe></template>",
    );

    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("<iframe");
  });
});

describe("rendered templates are sanitised", () => {
  test("a Liquid expression cannot assemble an off-origin form action", async () => {
    const engine = createTemplateEngine({ islands: {} });
    const compiled = engine.compile('<form action="{{ target }}"><input name="q"></form>');
    const external = await engine.render(compiled, { target: "https://evil.test/steal" }, runtime);
    const internal = await engine.render(compiled, { target: "/search" }, runtime);

    expect(sanitiseRenderedMarkup(external).html).not.toContain("evil.test");
    expect(sanitiseRenderedMarkup(internal).html).toContain('action="/search"');
  });

  test("a SafeHtml field cannot smuggle an event handler", async () => {
    const engine = createTemplateEngine({ islands: {} });
    const compiled = engine.compile("<div {{ attrs }}>x</div>");
    const html = await engine.render(
      compiled,
      { attrs: safeHtml('onclick="steal()" data-x="1"') },
      runtime,
    );
    const sanitised = sanitiseRenderedMarkup(html);

    expect(sanitised.html).toContain('data-x="1"');
    expect(sanitised.html).not.toContain("onclick");
  });

  test("a Liquid-assembled script element is removed", async () => {
    const engine = createTemplateEngine({ islands: {} });
    const compiled = engine.compile("<{{ tag }}>alert(1)</{{ tag }}><p>ok</p>");
    const html = await engine.render(compiled, { tag: "script" }, runtime);

    expect(sanitiseRenderedMarkup(html).html).toBe("<p>ok</p>");
  });

  test("renderThemeTemplate sanitises hook output and reports it", async () => {
    const engine = createTemplateEngine({ islands: {} });
    const compiled = createCompileCache(engine).compile(
      buildTheme([{ name: "default", templates: { page: '<main>{% hook "x" %}</main>' } }]),
      1,
    );
    const page = await renderThemeTemplate({
      engine,
      compiled,
      name: "page",
      viewModel: {},
      runtime: {
        ...runtime,
        hooks: { x: "<script>alert(1)</script><p data-hook>ok</p>" },
      },
    });

    expect(page.html).toBe('<main><p data-hook="">ok</p></main>');
    expect(page.violations).toHaveLength(1);
    expect(page.violations[0]?.kind).toBe("sanitise");
    expect(page.violations[0]?.message).toContain("the script element");
  });
});
