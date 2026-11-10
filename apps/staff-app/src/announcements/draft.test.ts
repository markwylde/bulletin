import { describe, expect, test } from "bun:test";
import { type AnnouncementRecord, draftFrom, emptyDraft, payloadFromDraft } from "./draft.ts";

const RECORD: AnnouncementRecord = {
  id: "9",
  title: "Mixed scope",
  body: "Body",
  scope: "forums",
  startsAt: "2026-01-01T10:00:00.000Z",
  endsAt: null,
  dismissible: true,
  version: 1,
  targets: [
    { forumId: "2", includeSubforums: true },
    { forumId: "3", includeSubforums: false },
  ],
  groupIds: ["4"],
};

describe("announcement draft", () => {
  test("preserves each target's sub-forum choice when editing", () => {
    const draft = draftFrom(RECORD);

    expect(draft.targets).toEqual([
      { forumId: "2", includeSubforums: true },
      { forumId: "3", includeSubforums: false },
    ]);
    expect(payloadFromDraft(draft).targets).toEqual([
      { forumId: "2", includeSubforums: true },
      { forumId: "3", includeSubforums: false },
    ]);
  });

  test("starts global with no target flags", () => {
    const draft = emptyDraft(new Date("2026-02-03T12:34:00.000Z"));

    expect(draft.scope).toBe("global");
    expect(draft.targets).toEqual([]);
    expect(payloadFromDraft(draft).targets).toEqual([]);
  });
});
