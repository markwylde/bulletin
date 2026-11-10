import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import { createTemplateEngine, type TemplateRuntime } from "@bulletin/templates";
import { renderToStaticMarkup } from "react-dom/server";
import * as v from "valibot";
import { CLIENT_ISLANDS } from "./client.ts";
import { SpikeCounter, type SpikeCounterProps } from "./SpikeCounter.tsx";
import { ISLAND_NAMES, spikeCounterSchema } from "./schemas.ts";
import { SERVER_ISLANDS } from "./server.tsx";

const runtime = (report?: (message: string) => void): TemplateRuntime => ({
  translate: createServerT("en"),
  hooks: {},
  ...(report === undefined ? {} : { report }),
});

function renderIsland(viewModel: object, report?: (message: string) => void): Promise<string> {
  const engine = createTemplateEngine({ islands: SERVER_ISLANDS });
  return engine.render(
    engine.compile('{% island "SpikeCounter" island %}'),
    viewModel,
    runtime(report),
  );
}

describe("island registry", () => {
  test("every island has a server half, a client half and a schema", () => {
    expect(Object.keys(SERVER_ISLANDS).sort()).toEqual([...ISLAND_NAMES].sort());
    expect(Object.keys(CLIENT_ISLANDS).sort()).toEqual([...ISLAND_NAMES].sort());
  });

  test("the schema output is exactly the component's props", () => {
    const props: SpikeCounterProps = v.parse(spikeCounterSchema, { label: "  Clicks  " });

    expect(props).toEqual({ label: "Clicks", start: 0 });
  });
});

describe("{% island %} emission", () => {
  test("server-renders the component inside bl-island with the props for hydration", async () => {
    const html = await renderIsland({ island: { label: "Clicks", start: 2 } });

    expect(html).toContain('<bl-island data-name="SpikeCounter"');
    expect(html).toContain(
      'data-props="{&quot;label&quot;:&quot;Clicks&quot;,&quot;start&quot;:2}"',
    );
    expect(html).toContain('data-spike-count="2"');
    expect(html).toContain("<button");
  });

  test("applies schema defaults before rendering", async () => {
    const html = await renderIsland({ island: { label: "Clicks" } });

    expect(html).toContain('data-spike-count="0"');
  });

  test("escapes props so they cannot break out of the attribute", async () => {
    const html = await renderIsland({ island: { label: '"><script>alert(1)</script>' } });

    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("omits an island whose props fail the schema and reports it", async () => {
    const reports: string[] = [];
    const html = await renderIsland({ island: { label: "  " } }, (message) =>
      reports.push(message),
    );

    expect(html).toBe("");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('invalid props for island "SpikeCounter"');
    expect(reports[0]).toContain("label");
  });

  test("rejects unknown props instead of silently dropping them", async () => {
    const reports: string[] = [];
    const html = await renderIsland(
      { island: { label: "Clicks", start: 0, personal: "leak" } },
      (message) => reports.push(message),
    );

    expect(html).toBe("");
    expect(reports[0]).toContain("invalid props");
  });
});

describe("props schema", () => {
  test("accepts a label and a non-negative integer start", () => {
    expect(v.safeParse(spikeCounterSchema, { label: "Clicks", start: 3 }).success).toBe(true);
  });

  test("rejects blank labels, negative or fractional starts, arrays and null", () => {
    expect(v.safeParse(spikeCounterSchema, { label: "" }).success).toBe(false);
    expect(v.safeParse(spikeCounterSchema, { label: "x", start: -1 }).success).toBe(false);
    expect(v.safeParse(spikeCounterSchema, { label: "x", start: 1.5 }).success).toBe(false);
    expect(v.safeParse(spikeCounterSchema, { label: "x", start: "2" }).success).toBe(false);
    expect(v.safeParse(spikeCounterSchema, []).success).toBe(false);
    expect(v.safeParse(spikeCounterSchema, null).success).toBe(false);
  });
});

describe("client registry", () => {
  test("validates props before it loads the island chunk", () => {
    const invalid = CLIENT_ISLANDS.SpikeCounter?.prepare({ label: "" });
    const valid = CLIENT_ISLANDS.SpikeCounter?.prepare({ label: "Clicks", start: 1 });

    expect(invalid?.ok).toBe(false);
    expect(valid?.ok).toBe(true);
  });
});

describe("SpikeCounter", () => {
  test("server markup shows the label and the starting count", () => {
    const markup = renderToStaticMarkup(<SpikeCounter label="Clicks" start={3} />);

    expect(markup).toContain("data-spike-counter");
    expect(markup).toContain("Clicks");
    expect(markup).toContain('data-spike-count="3"');
  });
});
