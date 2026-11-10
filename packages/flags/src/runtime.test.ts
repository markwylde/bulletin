import { describe, expect, test } from "bun:test";
import { defineFlag } from "./defaults.ts";
import type { FlagDefinitionSource } from "./runtime.ts";
import { createFlagRuntime } from "./runtime.ts";
import type { FlagDefinition, FlagViewer } from "./types.ts";

const MEMBER: FlagViewer = { memberId: "7", groups: ["members"] };

function flag(
  key: string,
  overrides: Partial<FlagDefinition> = {},
  rules: FlagDefinition["rules"] = [],
): FlagDefinition {
  return {
    ...defineFlag({ key, description: `${key} flag`, owner: "core", default: false }),
    rules,
    ...overrides,
  };
}

function fakeSource(initial: readonly FlagDefinition[]): {
  readonly source: FlagDefinitionSource;
  readonly loads: () => number;
  set(next: readonly FlagDefinition[], bump?: boolean): void;
} {
  let definitions = initial;
  let version = "0";
  let loads = 0;

  return {
    source: {
      async version() {
        return version;
      },
      async load() {
        loads += 1;
        return definitions;
      },
    },
    loads: () => loads,
    set(next, bump = true) {
      definitions = next;

      if (bump) {
        version = String(Number(version) + 1);
      }
    },
  };
}

describe("flag runtime", () => {
  test("fails closed before the first load and evaluates after it", async () => {
    const { source } = fakeSource([flag("newEditor", { defaultValue: true })]);
    const runtime = createFlagRuntime(source);

    expect(runtime.isOn(MEMBER, "newEditor")).toBe(false);

    await runtime.ensureFresh();

    expect(runtime.has("newEditor")).toBe(true);
    expect(runtime.isOn(MEMBER, "newEditor")).toBe(true);
    expect(runtime.isOn(MEMBER, "missingFlag")).toBe(false);
  });

  test("reloads when the flags tag version changes", async () => {
    const { source, set } = fakeSource([flag("newEditor")]);
    const runtime = createFlagRuntime(source, { backstopMs: 0 });

    await runtime.ensureFresh();
    expect(runtime.isOn(MEMBER, "newEditor")).toBe(false);

    set([flag("newEditor", { defaultValue: true })]);
    await runtime.ensureFresh();

    expect(runtime.isOn(MEMBER, "newEditor")).toBe(true);
  });

  test("invalidate forces a reload even when the tag version is unchanged", async () => {
    const { source, loads, set } = fakeSource([flag("newEditor")]);
    const runtime = createFlagRuntime(source, { backstopMs: 60_000 });

    await runtime.ensureFresh();
    expect(loads()).toBe(1);

    set([flag("newEditor", { defaultValue: true })], false);
    await runtime.ensureFresh();
    expect(loads()).toBe(1);

    runtime.invalidate();
    await runtime.ensureFresh();
    expect(loads()).toBe(2);
    expect(runtime.isOn(MEMBER, "newEditor")).toBe(true);
  });

  test("checks the tag at most once per backstop interval", async () => {
    const { source, loads } = fakeSource([flag("newEditor")]);
    const runtime = createFlagRuntime(source, { backstopMs: 60_000 });

    await Promise.all([runtime.ensureFresh(), runtime.ensureFresh(), runtime.ensureFresh()]);
    await runtime.ensureFresh();

    expect(loads()).toBe(1);
  });

  test("reports render flags, their hash and client-visible values", async () => {
    const { source } = fakeSource([
      flag("newEditor", { affectsRender: true, clientVisible: true }, [
        { type: "group", groups: ["moderators"], value: true },
      ]),
      flag("internalTools", { clientVisible: false }),
    ]);
    const runtime = createFlagRuntime(source);

    await runtime.ensureFresh();

    expect(runtime.evaluateAll(MEMBER)).toEqual({ newEditor: false, internalTools: false });
    expect(runtime.renderFlags(MEMBER)).toEqual({ newEditor: false });
    expect(runtime.renderFlagsHash(MEMBER)).toBe(runtime.renderFlagsHash(MEMBER));
    expect(runtime.clientFlags(MEMBER)).toEqual({ newEditor: false });
  });
});
