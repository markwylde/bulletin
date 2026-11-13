import { describe, expect, test } from "bun:test";
import {
  capabilityBitIndex,
  forumActionMask,
  forumActionsFromMask,
  hasCapabilityBit,
  loadPluginForumActions,
  MODERATOR_POWERS,
  matrixForumActions,
  PLUGIN_FORUM_ACTION_BASE,
  pluginForumActionDefinitions,
  registerPluginForumAction,
} from "./actions.ts";

describe("plugin forum actions", () => {
  test("appends after every core action and moderator power without renumbering", () => {
    registerPluginForumAction({
      key: "plugin.tips.can_tip",
      labelKey: "plugin.tips.action.canTip",
      bit: 23,
    });

    expect(matrixForumActions()).toContain("plugin.tips.can_tip");
    expect(capabilityBitIndex("plugin.tips.can_tip")).toBe(PLUGIN_FORUM_ACTION_BASE);
    expect(capabilityBitIndex("read")).toBeLessThan(PLUGIN_FORUM_ACTION_BASE);
    expect(capabilityBitIndex("edit")).toBeLessThan(PLUGIN_FORUM_ACTION_BASE);
    expect(PLUGIN_FORUM_ACTION_BASE).toBe(23);
    expect(pluginForumActionDefinitions()).toHaveLength(1);
  });

  test("round-trips through the stored forum action mask", () => {
    registerPluginForumAction({
      key: "plugin.tips.can_tip",
      labelKey: "plugin.tips.action.canTip",
      bit: 23,
    });
    const mask = forumActionMask(["show", "read", "plugin.tips.can_tip"]);

    expect(hasCapabilityBit(mask, "plugin.tips.can_tip")).toBe(true);
    expect(forumActionsFromMask(mask)).toEqual(["show", "read", "plugin.tips.can_tip"]);
  });

  test("loads installed forum actions from the shared registry", async () => {
    await loadPluginForumActions((async () => [
      { plugin_id: "tips", key: "plugin.tips.can_tip", label_key: "plugin.tips.action.canTip" },
    ]) as never);

    expect(matrixForumActions()).toContain("plugin.tips.can_tip");
    expect(pluginForumActionDefinitions()).toContainEqual({
      key: "plugin.tips.can_tip",
      labelKey: "plugin.tips.action.canTip",
      bit: 23,
    });
  });

  test("allocates stable bits and never wraps into core actions", () => {
    registerPluginForumAction({ key: "plugin.extra.one", labelKey: "x", bit: 24 });

    expect(capabilityBitIndex("plugin.extra.one")).toBe(24);
    expect(capabilityBitIndex("plugin.tips.can_tip")).toBe(23);
    expect(capabilityBitIndex("show")).toBe(0);
    expect(capabilityBitIndex("read")).toBe(1);

    for (const definition of pluginForumActionDefinitions()) {
      expect(definition.bit).toBeGreaterThanOrEqual(23);
      expect(definition.bit).toBeLessThanOrEqual(30);
    }
  });

  test("refuses to allocate the same stable bit twice", () => {
    expect(() =>
      registerPluginForumAction({ key: "plugin.extra.two", labelKey: "x", bit: 24 }),
    ).toThrow("No stable permission bit");
  });

  test("rejects malformed plugin action keys", () => {
    expect(() =>
      registerPluginForumAction({
        key: "plugin.tips.CanTip" as "plugin.tips.can_tip",
        labelKey: "x",
      }),
    ).toThrow("Invalid plugin forum action");
    expect(MODERATOR_POWERS).not.toContain("plugin.tips.can_tip");
  });
});
