import { describe, expect, test } from "bun:test";
import { SEED_PUSH_KEYS } from "@bulletin/db/seed";
import { PUSH_TEST_KEYS } from "@bulletin/mock-push/test-keys";

describe("seeded push subscription", () => {
  test("uses the test keys the push mock can decrypt", () => {
    expect(SEED_PUSH_KEYS).toEqual({
      p256dh: PUSH_TEST_KEYS.publicKey,
      auth: PUSH_TEST_KEYS.auth,
    });
  });
});
