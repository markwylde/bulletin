import { describe, expect, test } from "bun:test";
import {
  claimReauthDrafts,
  clearReauthDraft,
  clearReauthDrafts,
  draftWriteFor,
  type LocalStore,
  readReauthDraft,
  reauthDraftKey,
  serializeDraftWrite,
  writeReauthDraft,
} from "./drafts.ts";

class MemoryStore implements LocalStore {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  get length(): number {
    return this.values.size;
  }
}

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

describe("member-scoped re-auth drafts", () => {
  test("a draft is only visible to the member who saved it", () => {
    const store = new MemoryStore();
    writeReauthDraft("11", "reply:topic:1", "Member one's private text", store);

    expect(reauthDraftKey("11", "reply:topic:1")).not.toBe(reauthDraftKey("12", "reply:topic:1"));
    expect(readReauthDraft("11", "reply:topic:1", store)).toBe("Member one's private text");
    expect(readReauthDraft("12", "reply:topic:1", store)).toBeNull();
  });

  test("a different account claims the store and the previous member's drafts are gone", () => {
    const store = new MemoryStore();
    claimReauthDrafts("11", store);
    writeReauthDraft("11", "reply:topic:1", "Member one's private text", store);

    expect(claimReauthDrafts("12", store)).toBe(true);
    expect(readReauthDraft("11", "reply:topic:1", store)).toBeNull();
    expect(store.length).toBe(1);
  });

  test("logout clears every draft and the owner marker", () => {
    const store = new MemoryStore();
    claimReauthDrafts("11", store);
    writeReauthDraft("11", "reply:topic:1", "one", store);
    writeReauthDraft("11", "reply:topic:2", "two", store);

    clearReauthDrafts(store);

    expect(store.length).toBe(0);
  });

  test("a draft saved by the previous version is discarded on first claim", () => {
    const store = new MemoryStore();
    store.setItem("bulletin:draft:reauth:reply:topic:1", JSON.stringify({ bodyMd: "old" }));

    claimReauthDrafts("11", store);

    expect(store.getItem("bulletin:draft:reauth:reply:topic:1")).toBeNull();
  });

  test("clearing one context leaves the member's other drafts alone", () => {
    const store = new MemoryStore();
    claimReauthDrafts("11", store);
    writeReauthDraft("11", "reply:topic:1", "one", store);
    writeReauthDraft("11", "reply:topic:2", "two", store);

    clearReauthDraft("11", "reply:topic:1", store);

    expect(readReauthDraft("11", "reply:topic:2", store)).toBe("two");
  });
});
