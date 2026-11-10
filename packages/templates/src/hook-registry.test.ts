import { describe, expect, test } from "bun:test";
import { auditHooks, declaredHooks, HOOK_NAMES, HOOK_POINTS } from "./hook-registry.ts";

describe("hook registry", () => {
  test("registers each hook once with a description", () => {
    expect(new Set(HOOK_NAMES).size).toBe(HOOK_NAMES.length);

    for (const point of HOOK_POINTS) {
      expect(point.name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
      expect(point.description.length).toBeGreaterThan(0);
    }
  });

  test("reads hooks a template places", () => {
    expect(
      declaredHooks("<main>{% hook \"post.userbar.after\" %}{% hook 'forum.row.after' %}</main>"),
    ).toEqual(["post.userbar.after", "forum.row.after"]);
    expect(declaredHooks("{% hook hookName %}")).toEqual([]);
  });
});

describe("auditHooks", () => {
  const registered = ["post.userbar.after", "forum.row.after"];

  test("passes when the theme contains every registered hook and nothing else", () => {
    expect(
      auditHooks(
        {
          page: '{% hook "post.userbar.after" %}',
          forum: '{% hook "forum.row.after" %}',
        },
        registered,
      ),
    ).toEqual({ missingRegistered: [], unregistered: [] });
  });

  test("reports a registered hook the default theme is missing", () => {
    expect(auditHooks({ page: '{% hook "post.userbar.after" %}' }, registered)).toEqual({
      missingRegistered: ["forum.row.after"],
      unregistered: [],
    });
  });

  test("reports a hook the theme uses that is not registered", () => {
    expect(
      auditHooks(
        {
          page: '{% hook "post.userbar.after" %}{% hook "post.userbar.afterr" %}',
          forum: '{% hook "forum.row.after" %}',
        },
        registered,
      ),
    ).toEqual({ missingRegistered: [], unregistered: ["post.userbar.afterr"] });
  });
});
