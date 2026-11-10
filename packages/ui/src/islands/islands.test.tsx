import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseSpikeCounterProps, SpikeCounter } from "./SpikeCounter.tsx";
import { SERVER_ISLANDS } from "./server.tsx";

describe("parseSpikeCounterProps", () => {
  test("accepts a label and an optional start", () => {
    expect(parseSpikeCounterProps({ label: "Clicks" })).toEqual({ label: "Clicks" });
    expect(parseSpikeCounterProps({ label: "Clicks", start: 2 })).toEqual({
      label: "Clicks",
      start: 2,
    });
  });

  test("rejects missing, blank or mistyped props", () => {
    expect(parseSpikeCounterProps(null)).toBeNull();
    expect(parseSpikeCounterProps([])).toBeNull();
    expect(parseSpikeCounterProps({})).toBeNull();
    expect(parseSpikeCounterProps({ label: " " })).toBeNull();
    expect(parseSpikeCounterProps({ label: "Clicks", start: 1.5 })).toBeNull();
    expect(parseSpikeCounterProps({ label: "Clicks", start: "2" })).toBeNull();
  });
});

describe("SpikeCounter", () => {
  test("server markup shows the label and the starting count", () => {
    const markup = renderToStaticMarkup(<SpikeCounter label="Clicks" start={3} />);

    expect(markup).toContain("data-spike-counter");
    expect(markup).toContain("Clicks");
    expect(markup).toContain('data-spike-count="3"');
  });

  test("the server registry rejects the same invalid props", () => {
    const island = SERVER_ISLANDS.SpikeCounter;

    if (island === undefined) {
      throw new Error("SpikeCounter island is not registered");
    }

    const rejected = island.parse({ label: "" });

    expect(rejected).toEqual({
      ok: false,
      reason: "SpikeCounter props do not match the island schema",
    });
  });
});
