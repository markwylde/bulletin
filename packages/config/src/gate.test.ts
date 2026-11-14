import { describe, expect, test } from "bun:test";
import { createRequestGate, gateClosedResponse } from "./gate.ts";

describe("request gate", () => {
  test("stays closed until every check passes, then stays open", async () => {
    let clock = 0;
    let journal = false;
    let calls = 0;
    const gate = createRequestGate(
      [
        { name: "database", check: () => true },
        {
          name: "journal",
          check: () => {
            calls += 1;
            return journal;
          },
        },
      ],
      { recheckMs: 1_000, now: () => clock },
    );

    expect(await gate.open()).toBe(false);
    journal = true;
    // Within the recheck window the closed result is reused.
    clock = 500;
    expect(await gate.open()).toBe(false);
    expect(calls).toBe(1);
    clock = 1_000;
    expect(await gate.open()).toBe(true);
    journal = false;
    clock = 5_000;
    expect(await gate.open()).toBe(true);
    expect(calls).toBe(2);
  });

  test("a check that throws keeps the gate closed", async () => {
    const gate = createRequestGate([
      {
        name: "journal",
        check: () => {
          throw new Error("storage down");
        },
      },
    ]);

    expect(await gate.open()).toBe(false);
  });

  test("an empty gate is open", async () => {
    expect(await createRequestGate([]).open()).toBe(true);
  });

  test("the closed response is a no-store 503 with Retry-After", async () => {
    const response = gateClosedResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({ code: "restoring" });
  });
});
