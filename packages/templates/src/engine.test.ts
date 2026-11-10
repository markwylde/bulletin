import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import {
  createTemplateEngine,
  escapeHtml,
  type IslandRegistry,
  type IslandRenderError,
  TEMPLATE_LIMITS,
} from "./index.ts";

const SHIPPED = {
  en: {
    "spike.rendering.title": "Rendering spike",
    "spike.rendering.hook": "From a plugin fragment",
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
    // React escapes text children the same way; the fake keeps the test dependency-free.
    render: (props) =>
      `<button type="button">${escapeHtml(String((props as { label?: unknown }).label))}</button>`,
  },
};

function engine(
  options: {
    readonly islands?: IslandRegistry;
    readonly hooks?: Readonly<Record<string, string>>;
    readonly errors?: IslandRenderError[];
  } = {},
) {
  const errors = options.errors ?? [];

  return createTemplateEngine({
    translate: createServerT("en", { shipped: SHIPPED }),
    islands: options.islands ?? ISLANDS,
    hooks: options.hooks ?? {},
    onIslandError: (error) => errors.push(error),
  });
}

describe("template engine", () => {
  test("autoescapes output and keeps safe markup from islands", async () => {
    const html = await engine().render("<h1>{{ title }}</h1>", {
      title: "<script>alert(1)</script>",
    });

    expect(html).toBe("<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>");
  });

  test("applies the ADR 0008 resource limits", () => {
    const { liquid } = engine();

    expect(liquid.options.renderLimit).toBe(TEMPLATE_LIMITS.renderLimit);
    expect(liquid.options.memoryLimit).toBe(TEMPLATE_LIMITS.memoryLimit);
    expect(liquid.options.parseLimit).toBe(TEMPLATE_LIMITS.parseLimit);
    expect(liquid.options.outputEscape).toBeFunction();
  });
});

describe("{% island %}", () => {
  test("server-renders the component and carries the props for hydration", async () => {
    const html = await engine().render('{% island "Counter" island %}', {
      island: { label: "Clicks" },
    });

    expect(html).toBe(
      '<bl-island data-name="Counter" data-props="{&quot;label&quot;:&quot;Clicks&quot;}">' +
        '<button type="button">Clicks</button></bl-island>',
    );
  });

  test("escapes props so they cannot break out of the attribute", async () => {
    const html = await engine().render('{% island "Counter" island %}', {
      island: { label: '"><script>alert(1)</script>' },
    });

    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("omits an island with invalid props, reports it and still renders the page", async () => {
    const errors: IslandRenderError[] = [];
    const html = await engine({ errors }).render('<main>{% island "Counter" island %}</main>', {
      island: { label: 42 },
    });

    expect(html).toBe("<main></main>");
    expect(errors).toEqual([
      {
        island: "Counter",
        reason: "invalid_props",
        message: 'invalid props for island "Counter": label must be a string',
      },
    ]);
  });

  test("omits an unregistered island and reports it", async () => {
    const errors: IslandRenderError[] = [];
    const html = await engine({ errors }).render('{% island "Missing" %}', {});

    expect(html).toBe("");
    expect(errors[0]?.reason).toBe("unknown_island");
    expect(errors[0]?.message).toContain('unknown island "Missing"');
  });

  test("rejects a tag without a name at parse time", () => {
    expect(() => engine().liquid.parse("{% island %}")).toThrow("requires an island name");
  });
});

describe("{% hook %}", () => {
  test("renders the plugin fragment in the page's scope", async () => {
    const html = await engine({
      hooks: { "spike.after.counter": "<aside data-hook>{{ label }}</aside>" },
    }).render('{% hook "spike.after.counter" %}', { label: "after" });

    expect(html).toBe("<aside data-hook>after</aside>");
  });

  test("escapes fragment output", async () => {
    const html = await engine({
      hooks: { "spike.after.counter": "{{ label }}" },
    }).render('{% hook "spike.after.counter" %}', { label: "<b>bold</b>" });

    expect(html).toBe("&lt;b&gt;bold&lt;/b&gt;");
  });

  test("renders nothing and reports a hook without a fragment", async () => {
    const reported: string[] = [];
    const templateEngine = createTemplateEngine({
      translate: createServerT("en", { shipped: SHIPPED }),
      islands: ISLANDS,
      hooks: {},
      onHookError: (error) => reported.push(error.message),
    });

    const html = await templateEngine.render('<main>{% hook "spike.missing" %}</main>', {});

    expect(html).toBe("<main></main>");
    expect(reported).toEqual(['no fragment registered for hook "spike.missing"']);
  });

  test("rejects a tag without a name at parse time", () => {
    expect(() => engine().liquid.parse("{% hook %}")).toThrow("requires a hook name");
  });
});

describe("{% t %} on the engine", () => {
  test("translates inside a template", async () => {
    const html = await engine().render('<h1>{% t "spike.rendering.title" %}</h1>', {});

    expect(html).toBe("<h1>Rendering spike</h1>");
  });
});
