import { describe, expect, test } from "bun:test";
import {
  type BeforeSaveStage,
  createBeforeSaveRegistry,
  defaultBeforeSaveStages,
} from "./before-save.ts";
import { saveContent } from "./pipeline.ts";
import { ContentError } from "./types.ts";

const context = {
  profile: "post" as const,
  context: { kind: "forum_post" as const, forumId: "1" },
  authorId: "7",
};

describe("beforeSave registry", () => {
  test("orders plugin transforms, core checks and veto filters regardless of registration", async () => {
    const calls: string[] = [];
    const stage = (name: string, phase: BeforeSaveStage["phase"]): BeforeSaveStage => ({
      name,
      phase,
      run(content) {
        calls.push(name);
        return content;
      },
    });
    const registry = createBeforeSaveRegistry([
      stage("veto", "plugin_veto"),
      stage("core", "core_check"),
      stage("transform", "plugin_transform"),
    ]);

    await registry.run("body", context);

    expect(calls).toEqual(["transform", "core", "veto"]);
  });

  test("registers the empty core hooks in order", () => {
    expect(defaultBeforeSaveStages().map((stage) => [stage.name, stage.phase])).toEqual([
      ["bad-words", "core_check"],
      ["link-limits", "core_check"],
      ["spam", "core_check"],
    ]);
  });

  test("core checks cannot rewrite the markdown", async () => {
    const registry = createBeforeSaveRegistry([
      {
        name: "rewriter",
        phase: "core_check",
        run() {
          return "changed";
        },
      },
    ]);

    expect(await registry.run("original", context)).toBe("original");
  });

  test("a transform adding a blocked word is still caught by the core check", async () => {
    await expect(
      saveContent("hello", {
        ...context,
        checks: { blockedWords: ["forbidden"] },
        stages: [
          {
            name: "plugin-transform",
            phase: "plugin_transform",
            run(content) {
              return `${content} forbidden`;
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "blocked_word" });
  });

  test("a transform adding links is still caught by the link limit", async () => {
    await expect(
      saveContent("hello", {
        ...context,
        checks: { maxLinks: 1 },
        stages: [
          {
            name: "plugin-transform",
            phase: "plugin_transform",
            run(content) {
              return `${content}\n\n[x](https://example.com) [y](https://example.com)`;
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "too_many_links" });
  });

  test("counts raw HTML anchors added by a transform", async () => {
    await expect(
      saveContent("hello", {
        ...context,
        checks: { maxLinks: 1 },
        stages: [
          {
            name: "plugin-transform",
            phase: "plugin_transform",
            run(content) {
              return `${content}<a href="https://example.com">x</a><a href="https://example.com">y</a>`;
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "too_many_links" });
  });

  test("checks substring block rules when no whole-word rules exist", async () => {
    await expect(
      saveContent("hello forbiddenpart", {
        ...context,
        checks: { blockedAnyWords: ["forbidden"] },
      }),
    ).rejects.toMatchObject({ code: "blocked_word" });
  });

  test("passes when no filter list or link limit is configured", async () => {
    const result = await saveContent("hello [x](https://example.com)", context);

    expect(result.bodyHtml).toContain("hello");
  });

  test("a veto filter rejects after the core checks pass", async () => {
    const order: string[] = [];

    await expect(
      saveContent("hello", {
        ...context,
        stages: [
          {
            name: "transform",
            phase: "plugin_transform",
            run(content) {
              order.push("transform");
              return content;
            },
          },
          {
            name: "check",
            phase: "core_check",
            run(content) {
              order.push("check");
              return content;
            },
          },
          {
            name: "veto",
            phase: "plugin_veto",
            run() {
              order.push("veto");
              throw new ContentError("blocked_word", "vetoed");
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "blocked_word" });
    expect(order).toEqual(["transform", "check", "veto"]);
  });
});
