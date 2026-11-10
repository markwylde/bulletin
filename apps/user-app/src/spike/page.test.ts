import { describe, expect, test } from "bun:test";
import { parseSpikeOptions, SPIKE_DEFAULT_OPTIONS, spikeEnabled } from "./page.ts";

describe("parseSpikeOptions", () => {
  test("defaults to the first theme and plugin generation", () => {
    expect(parseSpikeOptions(new URLSearchParams())).toEqual({
      theme: SPIKE_DEFAULT_OPTIONS.theme,
      plugins: SPIKE_DEFAULT_OPTIONS.plugins,
      bust: SPIKE_DEFAULT_OPTIONS.bust,
    });
  });

  test("accepts the alternate theme, a plugin generation and a measurement bust", () => {
    expect(
      parseSpikeOptions(new URLSearchParams({ theme: "alt", plugins: "2", bust: "12" })),
    ).toEqual({ theme: "alt", plugins: 2, bust: 12 });
  });

  test("rejects unknown themes and generations", () => {
    expect(parseSpikeOptions(new URLSearchParams({ theme: "missing" }))).toBeNull();
    expect(parseSpikeOptions(new URLSearchParams({ plugins: "3" }))).toBeNull();
    expect(parseSpikeOptions(new URLSearchParams({ plugins: "first" }))).toBeNull();
  });

  test("rejects an out-of-range bust", () => {
    expect(parseSpikeOptions(new URLSearchParams({ bust: "-1" }))).toBeNull();
    expect(parseSpikeOptions(new URLSearchParams({ bust: "1.5" }))).toBeNull();
    expect(parseSpikeOptions(new URLSearchParams({ bust: "1000001" }))).toBeNull();
  });
});

describe("spikeEnabled", () => {
  test("is available in Astro development only", () => {
    expect(spikeEnabled("development", true)).toBe(true);
    expect(spikeEnabled("production", true)).toBe(false);
    expect(spikeEnabled("development", false)).toBe(false);
  });
});
