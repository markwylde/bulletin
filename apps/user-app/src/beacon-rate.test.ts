import { describe, expect, test } from "bun:test";
import { BEACON_DEFAULT_BACKOFF_SECONDS, beaconRetryAt, isBeaconBackedOff } from "./beacon-rate.ts";

describe("beacon backoff", () => {
  test("stops sending until the retry timestamp has passed", () => {
    const now = 1_000_000;

    expect(isBeaconBackedOff(String(now + 30_000), now)).toBe(true);
    expect(isBeaconBackedOff(String(now), now)).toBe(false);
    expect(isBeaconBackedOff(String(now - 1), now)).toBe(false);
    expect(isBeaconBackedOff(null, now)).toBe(false);
    expect(isBeaconBackedOff("not-a-number", now)).toBe(false);
  });

  test("uses retry-after when the server supplies a positive delay", () => {
    expect(beaconRetryAt("120", 5_000)).toBe(5_000 + 120_000);
    expect(beaconRetryAt("0", 5_000)).toBe(5_000 + BEACON_DEFAULT_BACKOFF_SECONDS * 1_000);
    expect(beaconRetryAt(null, 5_000)).toBe(5_000 + BEACON_DEFAULT_BACKOFF_SECONDS * 1_000);
  });
});
