import { describe, expect, test } from "bun:test";
import {
  clearOfflineDrafts,
  listOfflineDrafts,
  MemoryOfflineDraftStore,
  saveOfflineDraft,
} from "./offline-drafts.ts";

describe("offline draft queue", () => {
  test("a saved draft is listed for its member only", async () => {
    const store = new MemoryOfflineDraftStore();

    const draft = await saveOfflineDraft(
      {
        memberId: "11",
        contextKey: "reply:topic:1",
        url: "/api/topics/1/replies",
        body: '{"bodyMd":"unsent"}',
      },
      store,
    );

    if (draft === null) {
      throw new Error("Expected a saved draft");
    }

    expect(await listOfflineDrafts("11", store)).toEqual([draft]);
    expect(await listOfflineDrafts("12", store)).toEqual([]);
  });

  test("drafts are ordered oldest first", async () => {
    const store = new MemoryOfflineDraftStore();

    await store.put({
      id: "b",
      memberId: "11",
      contextKey: "reply:topic:2",
      url: "/api/topics/2/replies",
      body: "{}",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    await store.put({
      id: "a",
      memberId: "11",
      contextKey: "reply:topic:1",
      url: "/api/topics/1/replies",
      body: "{}",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect((await listOfflineDrafts("11", store)).map((draft) => draft.id)).toEqual(["a", "b"]);
  });

  test("clearing the queue removes every member's drafts", async () => {
    const store = new MemoryOfflineDraftStore();

    await saveOfflineDraft({ memberId: "11", contextKey: "a", url: "/api/a", body: "{}" }, store);
    await saveOfflineDraft({ memberId: "12", contextKey: "b", url: "/api/b", body: "{}" }, store);
    await clearOfflineDrafts(store);

    expect(await listOfflineDrafts("11", store)).toEqual([]);
    expect(await listOfflineDrafts("12", store)).toEqual([]);
  });

  test("a guest does not create a device draft", async () => {
    const store = new MemoryOfflineDraftStore();

    expect(
      await saveOfflineDraft({ memberId: "", contextKey: "a", url: "/api/a", body: "{}" }, store),
    ).toBeNull();
    expect(store.drafts.size).toBe(0);
  });
});
