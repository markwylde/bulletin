import { describe, expect, test } from "bun:test";
import { assertFlagDefinitions, defineFlag } from "./defaults.ts";
import {
  clientFlagValues,
  evaluateFlag,
  flagBucket,
  renderFlagsHash,
  renderFlagValues,
} from "./evaluate.ts";
import { parseFlagRules } from "./rules.ts";
import { type FlagDefinition, type FlagViewer, GUEST_VIEWER } from "./types.ts";

const MEMBER: FlagViewer = { memberId: "7", groups: ["members"] };
const MODERATOR: FlagViewer = { memberId: "9", groups: ["members", "moderators"] };

function flagWith(
  overrides: Partial<FlagDefinition> = {},
  rules: FlagDefinition["rules"] = [],
): FlagDefinition {
  return {
    ...defineFlag({
      key: "newEditor",
      description: "Switches the new editor on.",
      owner: "content",
      default: false,
    }),
    rules,
    ...overrides,
  };
}

describe("group targeting", () => {
  test("enables a flag for a listed group and leaves everyone else on the default", () => {
    const flag = flagWith({}, [{ type: "group", groups: ["moderators"], value: true }]);

    expect(evaluateFlag(flag, MODERATOR)).toBe(true);
    expect(evaluateFlag(flag, MEMBER)).toBe(false);
  });

  test("can disable a flag that defaults to on", () => {
    const flag = flagWith({ defaultValue: true }, [
      { type: "group", groups: ["members"], value: false },
    ]);

    expect(evaluateFlag(flag, MEMBER)).toBe(false);
    expect(evaluateFlag(flag, GUEST_VIEWER)).toBe(true);
  });

  test("evaluates rules in order and the first match wins", () => {
    const flag = flagWith({}, [
      { type: "group", groups: ["moderators"], value: true },
      { type: "group", groups: ["members"], value: false },
    ]);

    expect(evaluateFlag(flag, MODERATOR)).toBe(true);
    expect(evaluateFlag(flag, MEMBER)).toBe(false);
  });

  test("matches any of the viewer's groups and any group in the rule", () => {
    const flag = flagWith({}, [
      { type: "group", groups: ["administrators", "moderators"], value: true },
    ]);

    expect(evaluateFlag(flag, MODERATOR)).toBe(true);
    expect(evaluateFlag(flag, MEMBER)).toBe(false);
  });
});

describe("stable percentage bucketing", () => {
  test("assigns the same member the same bucket on every evaluation", () => {
    const bucket = flagBucket("newEditor", "42");

    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(flagBucket("newEditor", "42")).toBe(bucket);
    }

    const flag = flagWith({}, [{ type: "percentage", percent: 37, value: true }]);
    const first = evaluateFlag(flag, { memberId: "42", groups: ["members"] });

    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(evaluateFlag(flag, { memberId: "42", groups: ["members"] })).toBe(first);
    }
  });

  test("goes from 0% to 100% deterministically", () => {
    const off = flagWith({}, [{ type: "percentage", percent: 0, value: true }]);
    const on = flagWith({}, [{ type: "percentage", percent: 100, value: true }]);

    for (let member = 0; member < 500; member += 1) {
      const viewer = { memberId: String(member), groups: ["members"] };
      expect(evaluateFlag(off, viewer)).toBe(false);
      expect(evaluateFlag(on, viewer)).toBe(true);
    }
  });

  test("raising the percentage keeps every member who already had the flag on", () => {
    const twenty = flagWith({}, [{ type: "percentage", percent: 20, value: true }]);
    const fifty = flagWith({}, [{ type: "percentage", percent: 50, value: true }]);

    let onAtTwenty = 0;

    for (let member = 0; member < 2_000; member += 1) {
      const viewer = { memberId: String(member), groups: ["members"] };

      if (evaluateFlag(twenty, viewer)) {
        onAtTwenty += 1;
        expect(evaluateFlag(fifty, viewer)).toBe(true);
      }
    }

    expect(onAtTwenty).toBeGreaterThan(0);
    expect(onAtTwenty).toBeLessThan(2_000);
  });

  test("rolls out roughly the requested share", () => {
    let on = 0;

    for (let member = 0; member < 10_000; member += 1) {
      if (flagBucket("newEditor", String(member)) < 2_000) {
        on += 1;
      }
    }

    expect(on).toBeGreaterThan(1_600);
    expect(on).toBeLessThan(2_400);
  });
});

describe("guests and render-affecting flags", () => {
  test("never applies a percentage rule to a guest on a render flag", () => {
    const flag = flagWith({ affectsRender: true }, [
      { type: "percentage", percent: 100, value: true },
    ]);

    expect(evaluateFlag(flag, GUEST_VIEWER)).toBe(false);
    expect(evaluateFlag(flag, MEMBER)).toBe(true);
  });

  test("keeps the default for a guest when the flag defaults to on", () => {
    const flag = flagWith({ affectsRender: true, defaultValue: true }, [
      { type: "percentage", percent: 100, value: false },
    ]);

    expect(evaluateFlag(flag, GUEST_VIEWER)).toBe(true);
    expect(evaluateFlag(flag, MEMBER)).toBe(false);
  });

  test("applies a Guests group rule to guests", () => {
    const flag = flagWith({ affectsRender: true }, [
      { type: "group", groups: ["guests"], value: true },
      { type: "percentage", percent: 100, value: true },
    ]);

    expect(evaluateFlag(flag, GUEST_VIEWER)).toBe(true);
  });

  test("a guest cannot be bucketed for a non-render flag either", () => {
    const flag = flagWith({ defaultValue: true }, [
      { type: "percentage", percent: 100, value: false },
    ]);

    expect(evaluateFlag(flag, GUEST_VIEWER)).toBe(true);
  });
});

describe("render flags and the cache variant", () => {
  const renderFlag = flagWith({ key: "newEditor", affectsRender: true }, [
    { type: "group", groups: ["moderators"], value: true },
  ]);
  const normalFlag = flagWith({ key: "reactions", affectsRender: false });

  test("includes only render-affecting flags", () => {
    expect(renderFlagValues([renderFlag, normalFlag], MODERATOR)).toEqual({ newEditor: true });
  });

  test("hashes the evaluated values deterministically", () => {
    const values = renderFlagValues([renderFlag, normalFlag], MODERATOR);

    expect(renderFlagsHash(values)).toBe(renderFlagsHash({ newEditor: true }));
    expect(renderFlagsHash(values)).not.toBe(renderFlagsHash({ newEditor: false }));
    expect(renderFlagsHash({})).toBe(renderFlagsHash({}));
  });

  test("a non-render flag change never changes the variant hash", () => {
    const withReactionsOn = renderFlagsHash(
      renderFlagValues([renderFlag, { ...normalFlag, defaultValue: true }], MODERATOR),
    );
    const withReactionsOff = renderFlagsHash(renderFlagValues([renderFlag, normalFlag], MODERATOR));

    expect(withReactionsOn).toBe(withReactionsOff);
  });
});

describe("client-visible export", () => {
  test("exports only flags marked clientVisible", () => {
    const visible = flagWith({ key: "newEditor", clientVisible: true });
    const hidden = flagWith({ key: "internalTools", clientVisible: false });

    expect(clientFlagValues([visible, hidden], MEMBER)).toEqual({ newEditor: false });
  });
});

describe("rule parsing", () => {
  test("keeps valid rules in order and drops malformed entries", () => {
    expect(
      parseFlagRules([
        { type: "group", groups: ["moderators", 7], value: true },
        { type: "percentage", percent: 50, value: true },
        { type: "percentage", percent: 101, value: true },
        { type: "percentage", percent: 12.5, value: true },
        { type: "video", value: true },
        { type: "group", groups: [], value: true },
        { type: "group", groups: ["members"], value: "yes" },
        null,
      ]),
    ).toEqual([
      { type: "group", groups: ["moderators"], value: true },
      { type: "percentage", percent: 50, value: true },
    ]);
  });

  test("treats a non-array column as no rules", () => {
    expect(parseFlagRules(null)).toEqual([]);
    expect(parseFlagRules({ type: "group" })).toEqual([]);
  });
});

describe("flag declarations", () => {
  test("defaults to off, not render-affecting and not client-visible", () => {
    const flag = defineFlag({
      key: "newEditor",
      description: "Switches the new editor on.",
      owner: "content",
      default: true,
    });

    expect(flag).toEqual({
      key: "newEditor",
      description: "Switches the new editor on.",
      owner: "content",
      defaultValue: true,
      affectsRender: false,
      clientVisible: false,
      rules: [],
    });
  });

  test("rejects invalid keys, descriptions and owners", () => {
    expect(() =>
      defineFlag({ key: "New Editor", description: "x", owner: "y", default: false }),
    ).toThrow("Invalid flag declaration");
    expect(() =>
      defineFlag({ key: "newEditor", description: " ", owner: "y", default: false }),
    ).toThrow("Invalid flag declaration");
    expect(() =>
      defineFlag({ key: "newEditor", description: "x", owner: "", default: false }),
    ).toThrow("Invalid flag declaration");
  });

  test("rejects duplicate keys in a registry", () => {
    const flag = defineFlag({
      key: "newEditor",
      description: "x",
      owner: "y",
      default: false,
    });

    expect(() => assertFlagDefinitions([flag, flag])).toThrow("Duplicate flag definition");
  });
});
