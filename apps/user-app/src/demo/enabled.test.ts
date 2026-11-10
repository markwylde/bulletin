import { describe, expect, test } from "bun:test";
import { demoEnabled } from "./enabled.ts";

describe("demoEnabled", () => {
  test("is available outside production only", () => {
    expect(demoEnabled("development")).toBe(true);
    expect(demoEnabled(undefined)).toBe(true);
    expect(demoEnabled("production")).toBe(false);
  });
});
