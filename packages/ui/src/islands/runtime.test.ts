import { describe, expect, test } from "bun:test";
import { readIslandProps } from "./runtime.ts";

describe("readIslandProps", () => {
  test("treats a missing or empty attribute as no props", () => {
    expect(readIslandProps(null)).toEqual({ ok: true, props: {} });
    expect(readIslandProps("")).toEqual({ ok: true, props: {} });
    expect(readIslandProps("   ")).toEqual({ ok: true, props: {} });
  });

  test("parses the JSON object the server emitted", () => {
    expect(readIslandProps('{"label":"Clicks","start":2}')).toEqual({
      ok: true,
      props: { label: "Clicks", start: 2 },
    });
    expect(readIslandProps('{"label":"Clicks"}')).toEqual({
      ok: true,
      props: { label: "Clicks" },
    });
  });

  test("reports malformed JSON instead of throwing", () => {
    const result = readIslandProps("{label:");

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toBe("data-props is not valid JSON");
    }
  });
});
