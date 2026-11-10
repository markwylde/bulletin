import { describe, expect, test } from "bun:test";
import { currentContentVersions, ensureCurrentRendering, isContentStale } from "./versioning.ts";

describe("content versions", () => {
  test("current rows are served without a refresh", async () => {
    const versions = currentContentVersions();
    const result = await ensureCurrentRendering(
      { bodyHtml: "<p>stored</p>", bodyText: "stored", ...versions },
      { profile: "post" },
    );

    expect(result.refreshed).toBe(false);
    expect(result.bodyHtml).toBe("<p>stored</p>");
    expect(result.bodyText).toBe("stored");
  });

  test("a sanitiser version mismatch is stale and re-sanitised on read", async () => {
    const versions = currentContentVersions();

    expect(isContentStale({ ...versions, sanitiserVersion: 0 }, versions)).toBe(true);

    const result = await ensureCurrentRendering(
      {
        bodyHtml: '<p>old</p><img src=x onerror="alert(1)">',
        renderVersion: versions.renderVersion,
        sanitiserVersion: 0,
      },
      { profile: "post" },
    );

    expect(result.refreshed).toBe(true);
    expect(result.bodyHtml).not.toContain("onerror");
    expect(result.bodyText).toBe("old");
  });

  test("a render version mismatch applies the current replace list on read", async () => {
    const versions = currentContentVersions({ version: 4, rules: [] });
    const replaceWords = { version: 4, rules: [{ word: "damn", replacement: "darn" }] };

    const result = await ensureCurrentRendering(
      {
        bodyHtml: "<p>A damn post</p>",
        bodyText: "A damn post",
        renderVersion: versions.renderVersion - 4,
        sanitiserVersion: versions.sanitiserVersion,
      },
      { profile: "post", replaceWords, versions },
    );

    expect(result.refreshed).toBe(true);
    expect(result.bodyHtml).toContain("darn");
    expect(result.bodyText).toBe("A darn post");
  });

  test("mention links are unwrapped for a viewer without the flag, stale or not", async () => {
    const versions = currentContentVersions();
    const bodyHtml =
      '<p>Hi <a href="/profile/42-jane" data-mention="42" rel="nofollow ugc noopener">@Jane</a></p>';

    const current = await ensureCurrentRendering(
      { bodyHtml, bodyText: "Hi @Jane", ...versions },
      { profile: "rules", mentions: false },
    );

    expect(current.refreshed).toBe(false);
    expect(current.bodyHtml).toBe("<p>Hi @Jane</p>");

    // A stale row is re-sanitised first, then gated; the marker survives the refresh.
    const stale = await ensureCurrentRendering(
      { bodyHtml, renderVersion: versions.renderVersion - 1, sanitiserVersion: 0 },
      { profile: "rules", mentions: false },
    );

    expect(stale.refreshed).toBe(true);
    expect(stale.bodyHtml).toBe("<p>Hi @Jane</p>");

    // The same row keeps its link for a viewer with the flag on.
    const enabled = await ensureCurrentRendering(
      { bodyHtml, bodyText: "Hi @Jane", ...versions },
      { profile: "rules", mentions: true },
    );

    expect(enabled.bodyHtml).toContain('href="/profile/42-jane"');
  });
});
