import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import {
  createTemplateEngine,
  DEFAULT_TEMPLATE_LIMITS,
  escapeHtml,
  escapeOutput,
  type IslandRegistry,
  safeHtml,
  type TemplateRuntime,
} from "./index.ts";

const SHIPPED = {
  en: {
    "spike.rendering.title": "Rendering spike",
    "spike.rendering.hook": "From a plugin fragment",
  },
  es: {
    "spike.rendering.title": "Prueba de renderizado",
    "spike.rendering.hook": "Desde un fragmento de plugin",
  },
} as const;

const ISLANDS: IslandRegistry = {
  Counter: {
    parse: (input) => {
      if (typeof input !== "object" || input === null) {
        return { ok: false, reason: "expected an object" };
      }

      const props = input as Record<string, unknown>;

      if (typeof props.label !== "string") {
        return { ok: false, reason: "label must be a string" };
      }

      return { ok: true, props: { label: props.label } };
    },
    render: (props) =>
      `<button type="button">${escapeHtml(String((props as { label?: unknown }).label))}</button>`,
  },
};

function runtime(overrides: Partial<TemplateRuntime> = {}): TemplateRuntime {
  return {
    translate: createServerT("en", { shipped: SHIPPED }),
    hooks: {},
    ...overrides,
  };
}

function render(
  source: string,
  viewModel: object = {},
  options: { readonly runtime?: TemplateRuntime; readonly islands?: IslandRegistry } = {},
): Promise<string> {
  const engine = createTemplateEngine({ islands: options.islands ?? ISLANDS });
  return engine.render(engine.compile(source), viewModel, options.runtime ?? runtime());
}

describe("template engine", () => {
  test("autoescapes output", async () => {
    expect(await render("<h1>{{ title }}</h1>", { title: "<script>alert(1)</script>" })).toBe(
      "<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>",
    );
  });

  test("passes SafeHtml view-model fields through unescaped", async () => {
    const html = await render("<main>{{ body }}</main>", {
      body: safeHtml("<p>Already sanitised</p>"),
    });

    expect(html).toBe("<main><p>Already sanitised</p></main>");
  });

  test("escapes a SafeHtml field once a filter turns it into text", async () => {
    const html = await render("{{ body | upcase }}", { body: safeHtml("<b>bold</b>") });

    expect(html).toBe("&lt;B&gt;BOLD&lt;/B&gt;");
  });

  test("has no filter that can mark text safe", () => {
    const engine = createTemplateEngine({ islands: ISLANDS });

    expect(() => engine.compile("{{ value | raw }}")).toThrow();
  });

  test("applies the ADR 0008 resource limits", () => {
    const { liquid, limits } = createTemplateEngine({ islands: ISLANDS });

    expect(limits).toEqual(DEFAULT_TEMPLATE_LIMITS);
    expect(liquid.options.renderLimit).toBe(DEFAULT_TEMPLATE_LIMITS.renderLimit);
    expect(liquid.options.memoryLimit).toBe(DEFAULT_TEMPLATE_LIMITS.memoryLimit);
    expect(liquid.options.parseLimit).toBe(DEFAULT_TEMPLATE_LIMITS.parseLimit);
    expect(liquid.options.outputEscape).toBe(escapeOutput);
  });

  test("compiles once and renders with different locales", async () => {
    const engine = createTemplateEngine({ islands: ISLANDS });
    const compiled = engine.compile('{% t "spike.rendering.title" %}');

    expect(await engine.render(compiled, {}, runtime())).toBe("Rendering spike");
    expect(
      await engine.render(
        compiled,
        {},
        runtime({ translate: createServerT("es", { shipped: SHIPPED }) }),
      ),
    ).toBe("Prueba de renderizado");
  });

  test("cannot include templates from the filesystem", () => {
    const engine = createTemplateEngine({ islands: ISLANDS });

    expect(() => engine.compile('{% include "package.json" %}')).toThrow();
    expect(() => engine.compile('{% render "package.json" %}')).toThrow();
  });

  test("fails loudly when a template is rendered without a runtime", async () => {
    const engine = createTemplateEngine({ islands: ISLANDS });

    await expect(
      engine.render(engine.compile('{% t "spike.rendering.title" %}'), {}, { hooks: {} } as never),
    ).rejects.toThrow("without a Bulletin runtime");
  });
});

describe("{% island %}", () => {
  test("server-renders the component and carries the props for hydration", async () => {
    const html = await render('{% island "Counter" island %}', {
      island: { label: "Clicks" },
    });

    expect(html).toBe(
      '<bl-island data-name="Counter" data-props="{&quot;label&quot;:&quot;Clicks&quot;}">' +
        '<button type="button">Clicks</button></bl-island>',
    );
  });

  test("escapes props so they cannot break out of the attribute", async () => {
    const html = await render('{% island "Counter" island %}', {
      island: { label: '"><script>alert(1)</script>' },
    });

    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("omits an island with invalid props, reports it and still renders the page", async () => {
    const reports: string[] = [];
    const html = await render(
      '<main>{% island "Counter" island %}</main>',
      { island: { label: 42 } },
      { runtime: runtime({ report: (message) => reports.push(message) }) },
    );

    expect(html).toBe("<main></main>");
    expect(reports).toEqual([
      'invalid_props: invalid props for island "Counter": label must be a string',
    ]);
  });

  test("omits an unregistered island and reports it", async () => {
    const reports: string[] = [];
    const html = await render(
      '{% island "Missing" %}',
      {},
      { runtime: runtime({ report: (message) => reports.push(message) }) },
    );

    expect(html).toBe("");
    expect(reports[0]).toContain('unknown island "Missing"');
  });

  test("rejects a tag without a name at parse time", () => {
    expect(() => createTemplateEngine({ islands: ISLANDS }).compile("{% island %}")).toThrow(
      "requires an island name",
    );
  });
});

describe("{% hook %}", () => {
  test("renders the plugin fragment in the page's scope", async () => {
    const html = await render(
      '{% hook "spike.after.counter" %}',
      { label: "after" },
      {
        runtime: runtime({
          hooks: { "spike.after.counter": "<aside data-hook>{{ label }}</aside>" },
        }),
      },
    );

    expect(html).toBe("<aside data-hook>after</aside>");
  });

  test("escapes fragment output", async () => {
    const html = await render(
      '{% hook "spike.after.counter" %}',
      { label: "<b>bold</b>" },
      { runtime: runtime({ hooks: { "spike.after.counter": "{{ label }}" } }) },
    );

    expect(html).toBe("&lt;b&gt;bold&lt;/b&gt;");
  });

  test("renders nothing and reports a hook without a fragment", async () => {
    const reports: string[] = [];
    const html = await render(
      '<main>{% hook "spike.missing" %}</main>',
      {},
      { runtime: runtime({ report: (message) => reports.push(message) }) },
    );

    expect(html).toBe("<main></main>");
    expect(reports).toEqual(['unregistered: no fragment registered for hook "spike.missing"']);
  });

  test("rejects a tag without a name at parse time", () => {
    expect(() => createTemplateEngine({ islands: ISLANDS }).compile("{% hook %}")).toThrow(
      "requires a hook name",
    );
  });
});
