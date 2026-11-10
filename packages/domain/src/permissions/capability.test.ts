import { describe, expect, test } from "bun:test";
import { forumActionMask } from "./actions.ts";
import { announcementAudience, CapabilityView } from "./capability.ts";
import { FIXTURE_FORUM_TREE, FIXTURE_PASSWORD_FORUM_ID } from "./fixtures.ts";

const READ_AND_SHOW = forumActionMask(["show", "read"]);

function view(options: {
  readonly unlocked?: readonly string[];
  readonly bits?: Readonly<Record<string, number>>;
}): CapabilityView {
  return new CapabilityView({
    tree: FIXTURE_FORUM_TREE,
    bits: new Map(Object.entries(options.bits ?? {})),
    unlocked: new Set(options.unlocked ?? []),
  });
}

describe("CapabilityView password unlocks", () => {
  test("folds the unlock into the effective read bit of a password forum", () => {
    const locked = view({ bits: { [FIXTURE_PASSWORD_FORUM_ID]: READ_AND_SHOW } });
    const unlocked = view({
      bits: { [FIXTURE_PASSWORD_FORUM_ID]: READ_AND_SHOW },
      unlocked: [FIXTURE_PASSWORD_FORUM_ID],
    });

    expect(locked.read(FIXTURE_PASSWORD_FORUM_ID)).toBe(false);
    expect(unlocked.read(FIXTURE_PASSWORD_FORUM_ID)).toBe(true);
  });

  test("an unlock outside a password forum does not change its read bit", () => {
    const locked = view({ bits: { "1": READ_AND_SHOW } });
    const withOtherUnlock = view({
      bits: { "1": READ_AND_SHOW },
      unlocked: [FIXTURE_PASSWORD_FORUM_ID],
    });

    expect(locked.read("1")).toBe(true);
    expect(withOtherUnlock.read("1")).toBe(true);
    expect(withOtherUnlock.isCdnCacheable()).toBe(false);
  });

  test("non-read bits are unaffected by a password", () => {
    const locked = view({ bits: { [FIXTURE_PASSWORD_FORUM_ID]: READ_AND_SHOW } });

    expect(locked.has(FIXTURE_PASSWORD_FORUM_ID, "show")).toBe(true);
    expect(locked.has(FIXTURE_PASSWORD_FORUM_ID, "reply")).toBe(false);
  });

  test("denies every bit for an unknown forum", () => {
    const capability = view({});

    expect(capability.read("99")).toBe(false);
    expect(capability.has("99", "show")).toBe(false);
  });

  test("requests holding an unlock grant are never CDN-cacheable", () => {
    const locked = view({ bits: { [FIXTURE_PASSWORD_FORUM_ID]: READ_AND_SHOW } });
    const unlocked = view({
      bits: { [FIXTURE_PASSWORD_FORUM_ID]: READ_AND_SHOW },
      unlocked: [FIXTURE_PASSWORD_FORUM_ID],
    });

    expect(locked.isCdnCacheable()).toBe(true);
    expect(unlocked.isCdnCacheable()).toBe(false);
  });

  test("records every capability bit it was asked for", () => {
    const capability = view({ bits: { "1": forumActionMask(["show", "read"]) } });
    capability.read("1");
    capability.has("1", "reply");

    expect(capability.recordedReads()).toEqual([
      { forumId: "1", bit: "read", allowed: true, unlockDependent: false, unlocked: false },
      { forumId: "1", bit: "reply", allowed: false, unlockDependent: false, unlocked: false },
    ]);
  });
});

describe("visibility variants", () => {
  test("an unlocked viewer never shares a variant with a locked one", () => {
    const locked = view({ bits: { [FIXTURE_PASSWORD_FORUM_ID]: READ_AND_SHOW } });
    const unlocked = view({
      bits: { [FIXTURE_PASSWORD_FORUM_ID]: READ_AND_SHOW },
      unlocked: [FIXTURE_PASSWORD_FORUM_ID],
    });

    locked.read(FIXTURE_PASSWORD_FORUM_ID);
    unlocked.read(FIXTURE_PASSWORD_FORUM_ID);

    expect(locked.visibilityKey()).not.toBe(unlocked.visibilityKey());
  });

  test("viewers who read the same bits and unlocks share a variant", () => {
    const first = view({
      bits: { [FIXTURE_PASSWORD_FORUM_ID]: READ_AND_SHOW },
      unlocked: [FIXTURE_PASSWORD_FORUM_ID],
    });
    const second = view({
      bits: { [FIXTURE_PASSWORD_FORUM_ID]: READ_AND_SHOW },
      unlocked: [FIXTURE_PASSWORD_FORUM_ID],
    });

    expect(first.read(FIXTURE_PASSWORD_FORUM_ID)).toBe(true);
    expect(second.read(FIXTURE_PASSWORD_FORUM_ID)).toBe(true);
    expect(first.visibilityKey()).toBe(second.visibilityKey());
  });

  test("different capability answers produce different variants", () => {
    const reader = view({ bits: { "1": forumActionMask(["show", "read"]) } });
    const viewer = view({ bits: { "1": forumActionMask(["show"]) } });

    reader.read("1");
    viewer.read("1");

    expect(reader.visibilityKey()).not.toBe(viewer.visibilityKey());
  });

  test("the order bits are read in does not change the variant", () => {
    const first = view({ bits: { "1": forumActionMask(["show", "read"]) } });
    const second = view({ bits: { "1": forumActionMask(["show", "read"]) } });

    first.has("1", "show");
    first.read("1");
    second.read("1");
    second.has("1", "show");

    expect(first.visibilityKey()).toBe(second.visibilityKey());
  });
});

describe("announcement audience class", () => {
  const targeted = { id: "10", targetGroupIds: ["2"] };
  const other = { id: "11", targetGroupIds: ["3"] };
  const boardWide = { id: "12", targetGroupIds: [] };
  const announcements = [targeted, other, boardWide];

  test("hashes the announcements targeting one of the viewer's groups", () => {
    expect(announcementAudience({ groupIds: ["2"] }, announcements)).not.toBe(
      announcementAudience({ groupIds: ["3"] }, announcements),
    );
  });

  test("matches only targeted groups, plus board-wide notices", () => {
    expect(announcementAudience({ groupIds: ["4"] }, [targeted])).toBe(
      announcementAudience({ groupIds: [] }, [targeted]),
    );
    expect(announcementAudience({ groupIds: ["2"] }, [targeted])).not.toBe(
      announcementAudience({ groupIds: ["3"] }, [targeted]),
    );
    expect(announcementAudience({ groupIds: [] }, announcements)).toBe(
      announcementAudience({ groupIds: [] }, [boardWide]),
    );
  });

  test("is stable across input order and for equal memberships", () => {
    expect(announcementAudience({ groupIds: ["3", "2"] }, announcements)).toBe(
      announcementAudience({ groupIds: ["2", "3"] }, announcements),
    );
    expect(announcementAudience({ groupIds: ["2"] }, announcements)).toBe(
      announcementAudience({ groupIds: ["2"] }, [...announcements].reverse()),
    );
  });
});
