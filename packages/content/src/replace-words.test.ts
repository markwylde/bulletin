import { describe, expect, test } from "bun:test";
import { saveContent } from "./pipeline.ts";
import { applyReplaceWordsToHtml, refreshStoredHtml } from "./refresh.ts";
import { BASE_RENDER_VERSION, renderVersionFor, SANITISER_VERSION } from "./replace-words.ts";
import type { ReplaceWords } from "./types.ts";

const replaceWords: ReplaceWords = {
  version: 3,
  rules: [{ word: "damn", replacement: "darn" }],
};

function options() {
  return {
    profile: "post" as const,
    context: { kind: "forum_post" as const, forumId: "1" },
    authorId: "7",
    replaceWords,
  };
}

describe("replace words", () => {
  test("changes HTML and plain text but never body_md", async () => {
    const result = await saveContent("A damn fine post", options());

    expect(result.bodyMd).toBe("A damn fine post");
    expect(result.bodyHtml).toContain("darn");
    expect(result.bodyHtml).not.toContain("damn");
    expect(result.bodyText).toBe("A darn fine post");
  });

  test("matching is case-insensitive", async () => {
    const result = await saveContent("DAMN and Damn", options());

    expect(result.bodyText).toBe("darn and darn");
  });

  test("folds the list version into render_version", async () => {
    const result = await saveContent("hello", options());

    expect(result.renderVersion).toBe(renderVersionFor(replaceWords));
    expect(result.renderVersion).toBe(BASE_RENDER_VERSION * 1_000_000 + 3);
    expect(result.renderVersion).not.toBe(renderVersionFor());
    expect(result.sanitiserVersion).toBe(SANITISER_VERSION);
  });

  test("applies the current list on read for stale stored HTML", async () => {
    const stored = "<p>A damn fine post</p>";

    expect(await applyReplaceWordsToHtml(stored, replaceWords)).toContain("darn");
    expect(await applyReplaceWordsToHtml(stored, replaceWords)).not.toContain("damn");
    expect(await applyReplaceWordsToHtml(stored)).toBe(stored);
  });

  test("re-sanitises stored HTML while applying replace words", async () => {
    const refreshed = await refreshStoredHtml(
      '<p>A damn post</p><img src=x onerror="alert(1)"><script>alert(1)</script>',
      { profile: "post", replaceWords },
    );

    expect(refreshed.bodyHtml).toContain("darn");
    expect(refreshed.bodyHtml).not.toContain("onerror");
    expect(refreshed.bodyHtml).not.toContain("<script");
    expect(refreshed.bodyText).toBe("A darn post");
  });
});
