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
      url: "http://plugin-host:3004",
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
      url: "http://plugin-host:3004",
      fetch: async () => {
        throw new Error("down");
      },
    });

    await expect(client.filter(INPUT)).resolves.toEqual({ content: "teh cat" });
  });

  test("collects content-extension HTML from plugin-host", async () => {
    const client = createPluginWriteClient({
      url: "http://plugin-host:3004",
      fetch: async () => Response.json({ html: '<span class="tip">5</span>' }),
    });

    await expect(client.extend("hello")).resolves.toEqual(['<span class="tip">5</span>']);
  });

  test("fail-closed policy rejects when plugin-host is unavailable", async () => {
    const client = createPluginWriteClient({
      url: "http://plugin-host:3004",
      vetoFailMode: "closed",
      fetch: async () => {
        throw new Error("down");
      },
    });

    await expect(client.filter(INPUT)).resolves.toEqual({
      content: "teh cat",
      veto: { reasonKey: "plugin.veto.unavailable", pluginId: "plugin-host" },
    });

    await expect(client.filter(INPUT, { failClosed: true })).resolves.toMatchObject({
      veto: { reasonKey: "plugin.veto.unavailable" },
    });
  });
});
