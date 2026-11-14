import { describe, expect, test } from "bun:test";
import { requestDueState } from "./due.ts";

const NOW = new Date("2026-01-31T12:00:00Z").getTime();

describe("data request due state", () => {
  test("marks a 25-day-old request as due soon", () => {
    const due = new Date("2026-02-05T12:00:00Z");
    expect(requestDueState(due, "pending", NOW)).toBe("soon");
    expect(requestDueState(due, "processing", NOW)).toBe("soon");
  });

  test("separates overdue, soon and later requests", () => {
    expect(requestDueState(new Date("2026-01-30T12:00:00Z"), "pending", NOW)).toBe("overdue");
    expect(requestDueState(new Date("2026-02-20T12:00:00Z"), "pending", NOW)).toBe("later");
    expect(requestDueState(new Date("2026-01-30T12:00:00Z"), "completed", NOW)).toBe("later");
  });
});
