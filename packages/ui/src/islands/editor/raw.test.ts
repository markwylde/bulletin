import { describe, expect, test } from "bun:test";
import { preprocessRawBlocks, restoreRawBlocks } from "./milkdown.ts";

describe("raw block preservation", () => {
  test("restores unknown directive blocks exactly", () => {
    const original = "Hello\n\n:::disabled-plugin\nraw [b]hi[/b]\n:::\n\nWorld";
    const processed = preprocessRawBlocks(original);

    expect(processed.markdown).not.toContain(":::disabled-plugin");
    expect(restoreRawBlocks(processed.markdown, processed.raw)).toBe(original);
  });

  test("keeps raw blocks while surrounding content changes", () => {
    const original = ":::beta\nunknown *syntax*\n:::";
    const processed = preprocessRawBlocks(original);
    const edited = processed.markdown.replace("", "New intro\n\n");

    expect(restoreRawBlocks(edited, processed.raw)).toContain(original);
  });

  test("leaves literal placeholder-looking text untouched", () => {
    const original = "Literal ⟦raw-block-0⟧ text\n\n:::disabled-plugin\nraw\n:::";
    const processed = preprocessRawBlocks(original);
    const restored = restoreRawBlocks(processed.markdown, processed.raw);

    expect(restored).toBe(original);
    expect(restored.match(/:::disabled-plugin/g)?.length).toBe(1);
  });
});
