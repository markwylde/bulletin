import { describe, expect, test } from "bun:test";
import {
  createStringOverrideLayer,
  type StringOverrideSource,
  stringOverrideTag,
} from "./overrides.ts";

class FakeSource implements StringOverrideSource {
  readonly values = new Map<string, Record<string, string>>();
  versionNumber = 0;
  loads = 0;

  async version(): Promise<string> {
    return String(this.versionNumber);
  }

  async load(locale: string): Promise<Record<string, string>> {
    this.loads += 1;
    return this.values.get(locale) ?? {};
  }

  set(locale: string, key: string, value: string): void {
    const catalog = this.values.get(locale) ?? {};
    this.values.set(locale, { ...catalog, [key]: value });
    this.versionNumber += 1;
  }

  clear(locale: string, key: string): void {
    const catalog = { ...(this.values.get(locale) ?? {}) };
    delete catalog[key];
    this.values.set(locale, catalog);
    this.versionNumber += 1;
  }
}

describe("string override layer", () => {
  test("uses the tag name from ADR 0006", () => {
    expect(stringOverrideTag("es")).toBe("i18n:es");
  });

  test("applies an override and restores the shipped string after a revert", async () => {
    const source = new FakeSource();
    const layer = createStringOverrideLayer(source);

    expect(await layer.translate("en", "topic.reply.button")).toBe("Reply");

    source.set("en", "topic.reply.button", "Respond");
    expect(await layer.translate("en", "topic.reply.button")).toBe("Respond");

    source.clear("en", "topic.reply.button");
    expect(await layer.translate("en", "topic.reply.button")).toBe("Reply");
    expect(source.loads).toBe(3);
  });

  test("formats ICU values from an override", async () => {
    const source = new FakeSource();
    const layer = createStringOverrideLayer(source);

    source.set("en", "topic.reply.count", "{count, plural, one {# answer} other {# answers}}");

    expect(await layer.translate("en", "topic.reply.count", { count: 2 })).toBe("2 answers");
  });

  test("falls back to the shipped locale and then English", async () => {
    const layer = createStringOverrideLayer(new FakeSource());

    expect(await layer.translate("es", "topic.reply.button")).toBe("Responder");
    expect(await layer.message("en", "missing.key")).toBeUndefined();
    expect(await layer.translate("en", "missing.key")).toBe("missing.key");
  });

  test("invalidating forces the next lookup to reload", async () => {
    const source = new FakeSource();
    const layer = createStringOverrideLayer(source);

    await layer.overrides("en");
    await layer.overrides("en");
    expect(source.loads).toBe(1);

    layer.invalidate("en");
    await layer.overrides("en");
    expect(source.loads).toBe(2);
  });
});
