import { describe, expect, test } from "bun:test";
import { createPluginWriteClient } from "./plugins.ts";

const INPUT = {
  hook: "post.write",
  content: "teh cat",
  context: { authorId: "1", forumId: "2" },
  viewer: { memberId: "1" },
};

describe("plugin write filters", () => {
  test("returns the transformed content from plugin-host", async () => {
    const client = createPluginWriteClient({
      url: "http://plugin-host:3004",
      token: "secret",
      fetch: async () => Response.json({ content: "the cat", failures: [] }),
    });

    await expect(client.filter(INPUT)).resolves.toEqual({ content: "the cat" });
  });

  test("returns a veto with its translated reason key", async () => {
    const client = createPluginWriteClient({
      fetch: async () =>
        Response.json({
          content: "teh cat",
          veto: { reasonKey: "plugin.demo.veto", pluginId: "sandbox-demo" },
        }),
    });

    await expect(client.filter(INPUT)).resolves.toEqual({
      content: "teh cat",
      veto: { reasonKey: "plugin.demo.veto", pluginId: "sandbox-demo" },
    });
  });

  test("fails open when plugin-host is down", async () => {
    const client = createPluginWriteClient({
      fetch: async () => {
        throw new Error("down");
      },
    });

    await expect(client.filter(INPUT)).resolves.toEqual({ content: "teh cat" });
  });
});
