import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  ATTACHMENT_STATES,
  type AttachmentState,
  canTransition,
  transitionAttachment,
} from "./attachments.ts";

const ALLOWED: ReadonlyArray<readonly [AttachmentState, AttachmentState]> = [
  ["pending", "snapshotted"],
  ["snapshotted", "processing"],
  ["processing", "ready"],
  ["processing", "rejected"],
];

describe("attachment state machine", () => {
  test("allows only the documented transitions", () => {
    for (const from of ATTACHMENT_STATES) {
      for (const to of ATTACHMENT_STATES) {
        const allowed = ALLOWED.some(
          ([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to,
        );

        expect({ from, to, allowed: canTransition(from, to) }).toEqual({ from, to, allowed });
      }
    }
  });

  test("rejects an illegal transition before touching the database", async () => {
    let queries = 0;
    const sql = (() => {
      queries += 1;
      throw new Error("The database must not be queried");
    }) as unknown as SQL;

    await expect(
      transitionAttachment(sql, { id: "1", from: "pending", to: "ready" }),
    ).rejects.toThrow("cannot move from pending to ready");
    expect(queries).toBe(0);
  });

  test("requires the fields each state owns", async () => {
    const sql = (() => {
      throw new Error("The database must not be queried");
    }) as unknown as SQL;

    await expect(
      transitionAttachment(sql, { id: "1", from: "pending", to: "snapshotted" }),
    ).rejects.toThrow("snapshot key");
    await expect(
      transitionAttachment(sql, {
        id: "1",
        from: "pending",
        to: "snapshotted",
        snapshotKey: "processing/1",
      }),
    ).rejects.toThrow("positive size");
    await expect(
      transitionAttachment(sql, {
        id: "1",
        from: "pending",
        to: "snapshotted",
        snapshotKey: "processing/1",
        sizeBytes: 12,
        sha256: "not-hex",
      }),
    ).rejects.toThrow("SHA-256");
    await expect(
      transitionAttachment(sql, { id: "1", from: "processing", to: "ready" }),
    ).rejects.toThrow("storage key");
    await expect(
      transitionAttachment(sql, {
        id: "1",
        from: "processing",
        to: "ready",
        storageKey: "att/1",
        sizeBytes: 1,
        sha256: "not-hex",
        verifiedType: "image/png",
      }),
    ).rejects.toThrow("SHA-256");
    await expect(
      transitionAttachment(sql, { id: "1", from: "processing", to: "rejected" }),
    ).rejects.toThrow("reason code");
  });
});
