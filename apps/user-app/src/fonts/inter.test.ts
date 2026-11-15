import { describe, expect, test } from "bun:test";
import { INTER_FILES, interFilePath } from "./inter.ts";

describe("self-hosted Inter", () => {
  test("every public name resolves to a file in the pinned package", async () => {
    for (const name of Object.keys(INTER_FILES)) {
      const path = interFilePath(name);
      expect(path).not.toBeNull();
      expect(await Bun.file(path as string).exists()).toBe(true);
    }
  });

  test("unknown and traversal names are not served", () => {
    expect(interFilePath("../package.json")).toBeNull();
    expect(interFilePath("inter.css")).toBeNull();
  });
});
