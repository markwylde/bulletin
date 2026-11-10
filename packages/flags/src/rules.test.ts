import { describe, expect, test } from "bun:test";
import { MAX_FLAG_RULES, parseFlagRulesInput } from "./rules.ts";

describe("staff flag rule input", () => {
  test("accepts ordered group and percentage rules", () => {
    expect(
      parseFlagRulesInput([
        { type: "group", groups: ["members", "administrators"], value: true },
        { type: "percentage", percent: 50, value: false },
      ]),
    ).toEqual({
      ok: true,
      rules: [
        { type: "group", groups: ["members", "administrators"], value: true },
        { type: "percentage", percent: 50, value: false },
      ],
    });
  });

  test("rejects the whole submission when one rule is invalid", () => {
    expect(parseFlagRulesInput("nope")).toEqual({ ok: false, fields: ["rules"] });
    expect(parseFlagRulesInput([{ type: "group", groups: [], value: true }])).toEqual({
      ok: false,
      fields: ["rule-0-groups"],
    });
    expect(parseFlagRulesInput([{ type: "percentage", percent: 101, value: true }])).toEqual({
      ok: false,
      fields: ["rule-0"],
    });
    expect(parseFlagRulesInput([{ type: "percentage", percent: 10.5, value: true }])).toEqual({
      ok: false,
      fields: ["rule-0"],
    });
    expect(
      parseFlagRulesInput([
        { type: "group", groups: ["members"], value: true },
        { type: "group", groups: ["members"], value: "yes" },
      ]),
    ).toEqual({ ok: false, fields: ["rule-1"] });
  });

  test("bounds how many rules a flag may carry", () => {
    const rule = { type: "group", groups: ["members"], value: true } as const;

    expect(parseFlagRulesInput(Array.from({ length: MAX_FLAG_RULES }, () => rule)).ok).toBe(true);
    expect(parseFlagRulesInput(Array.from({ length: MAX_FLAG_RULES + 1 }, () => rule))).toEqual({
      ok: false,
      fields: ["rules"],
    });
  });
});
