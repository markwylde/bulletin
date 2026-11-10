import { describe, expect, test } from "bun:test";
import { createRenderCache, type TagVersionSource } from "@bulletin/cache";
import { isNotModified } from "../http/cache.ts";
import { renderCachedPage } from "./cached-route.ts";

function tagSource(): {
  readonly source: TagVersionSource;
  bump(): void;
} {
  let version = "1";

  return {
    source: { version: () => version, isTrusted: () => true },
    bump() {
      version = String(Number(version) + 1);
    },
  };
}

describe("shared page pipeline", () => {
  test("member and guest share the fragment but revalidate with different ETags", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });
    const input = {
      tags: ["board"],
      cache,
      tagVersions: tags.source,
      prepare: async () => ({ variant: "home", data: undefined }),
      render: async () => ({ html: "<main>home</main>", errors: [] }),
    };

    const guest = await renderCachedPage({
      ...input,
      shell: { visitor: "guest", localeSource: "guest" },
    });
    const member = await renderCachedPage({
      ...input,
      shell: { visitor: "member", localeSource: "member" },
    });

    expect(guest.cache).toBe("miss");
    // One shared fragment key and body; only the per-response shell changes.
    expect(member.variant).toBe(guest.variant);
    expect(member.cache).toBe("hit");
    expect(member.html).toBe(guest.html);
    expect(member.etag).not.toBe(guest.etag);
    expect(isNotModified(guest.etag, member.etag)).toBe(false);
    expect(isNotModified(member.etag, member.etag)).toBe(true);
  });

  test("a tag moving while the view model is prepared is reloaded, not stored stale", async () => {
    const tags = tagSource();
    const cache = createRenderCache({ tags: tags.source });
    let preparations = 0;
    let observed = "";

    const result = await renderCachedPage<string>({
      tags: ["board"],
      cache,
      tagVersions: tags.source,
      prepare: async () => {
        preparations += 1;
        observed = tags.source.version("board");

        if (preparations === 1) {
          // A settings save commits during the first attempt's data load.
          tags.bump();
        }

        return { variant: "home", data: observed };
      },
      render: async (version) => ({ html: `<main>${version}</main>`, errors: [] }),
    });

    expect(preparations).toBe(2);
    expect(result.html).toBe("<main>2</main>");
    expect(result.cache).toBe("miss");
    expect(tags.source.version("board")).toBe("2");

    // A later request is served from the retried entry, never from the stale first attempt.
    const warm = await renderCachedPage<string>({
      tags: ["board"],
      cache,
      tagVersions: tags.source,
      prepare: async () => ({ variant: "home", data: tags.source.version("board") }),
      render: async (version) => ({ html: `<main>${version}</main>`, errors: [] }),
    });

    expect(warm.cache).toBe("hit");
    expect(warm.html).toBe("<main>2</main>");
  });
});
