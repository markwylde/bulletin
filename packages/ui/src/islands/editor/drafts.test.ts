import { describe, expect, test } from "bun:test";
import { draftWriteFor, serializeDraftWrite } from "./drafts.ts";

describe("draft write mode", () => {
  test("clears the draft when an edit is undone back to the original", () => {
    expect(draftWriteFor("original", "changed", true)).toBe("save");
    expect(draftWriteFor("original", "original", true)).toBe("clear");
  });

  test("does nothing before the member edits", () => {
    expect(draftWriteFor("original", "original", false)).toBe("none");
  });
});

describe("serialised draft writes", () => {
  test("a delayed save cannot finish after a newer save or a clear", async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serializeDraftWrite("reply:topic:1", async () => {
      events.push("save-a:start");
      await firstGate;
      events.push("save-a:end");
      return "a";
    });
    const second = serializeDraftWrite("reply:topic:1", async () => {
      events.push("save-b");
      return "b";
    });
    const clear = serializeDraftWrite("reply:topic:1", async () => {
      events.push("clear");
      return true;
    });

    await Bun.sleep(1);
    expect(events).toEqual(["save-a:start"]);

    releaseFirst();
    const results = await Promise.all([first, second, clear]);

    expect(results).toEqual(["a", "b", true]);
    expect(events).toEqual(["save-a:start", "save-a:end", "save-b", "clear"]);
  });

  test("a failed write does not block the next write for the same context", async () => {
    const events: string[] = [];

    const failed = serializeDraftWrite("topic:2", async () => {
      events.push("failed");
      throw new Error("network");
    });
    const next = serializeDraftWrite("topic:2", async () => {
      events.push("next");
      return "saved";
    });

    await expect(failed).rejects.toThrow("network");
    expect(await next).toBe("saved");
    expect(events).toEqual(["failed", "next"]);
  });

  test("different contexts write independently", async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serializeDraftWrite("reply:topic:1", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const other = serializeDraftWrite("reply:topic:2", async () => {
      events.push("other");
    });

    await other;
    expect(events).toEqual(["first:start", "other"]);

    releaseFirst();
    await first;
    expect(events).toEqual(["first:start", "other", "first:end"]);
  });
});
