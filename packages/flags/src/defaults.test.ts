import { describe, expect, test } from "bun:test";
import {
  announcementsFlag,
  attachmentsFlag,
  avatarUploadFlag,
  CODE_FLAG_DEFINITIONS,
} from "./defaults.ts";

describe("announcements flag declaration", () => {
  test("is declared off by default and part of the cache variant", () => {
    expect(CODE_FLAG_DEFINITIONS).toContain(announcementsFlag);
    expect(announcementsFlag).toMatchObject({
      key: "announcements",
      defaultValue: false,
      affectsRender: true,
      clientVisible: true,
    });
  });
});

describe("attachment and avatar flag declarations", () => {
  test("default off in production and affect the render where needed", () => {
    expect(CODE_FLAG_DEFINITIONS).toContain(attachmentsFlag);
    expect(CODE_FLAG_DEFINITIONS).toContain(avatarUploadFlag);
    expect(attachmentsFlag).toMatchObject({
      key: "attachments",
      defaultValue: false,
      affectsRender: true,
      clientVisible: true,
    });
    expect(avatarUploadFlag).toMatchObject({
      key: "avatar_upload",
      defaultValue: false,
      affectsRender: false,
      clientVisible: true,
    });
  });
});
