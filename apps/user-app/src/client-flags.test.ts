import { describe, expect, test } from "bun:test";
import { flagFromJson } from "./client-flags.ts";

describe("client flags", () => {
  test("reads only an exact true value", () => {
    expect(flagFromJson('{"pwa":true,"web_push":false}', "pwa")).toBe(true);
    expect(flagFromJson('{"pwa":false}', "pwa")).toBe(false);
    expect(flagFromJson('{"pwa":"true"}', "pwa")).toBe(false);
    expect(flagFromJson("{}", "pwa")).toBe(false);
    expect(flagFromJson(null, "pwa")).toBe(false);
    expect(flagFromJson("not json", "pwa")).toBe(false);
  });
});
