import { describe, expect, test } from "bun:test";
import {
  BrokerLimitError,
  ConcurrencyGate,
  createBrokerBudgets,
  DEFAULT_BROKER_LIMITS,
  TokenBucket,
} from "./limits.ts";

describe("token bucket", () => {
  test("allows a burst then refills at the configured rate", () => {
    let now = 0;
    const bucket = new TokenBucket(2, { now: () => now });

    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    now = 500;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    now = 2_000;
    expect(bucket.take()).toBe(true);
    expect(bucket.tokens).toBeGreaterThan(0.9);
  });

  test("rejects invalid rates", () => {
    expect(() => new TokenBucket(0)).toThrow("ratePerSecond must be positive");
    expect(() => new TokenBucket(Number.NaN)).toThrow("ratePerSecond must be positive");
  });
});

describe("concurrency gate", () => {
  test("runs at most the limit and resolves queued work in order", async () => {
    const gate = new ConcurrencyGate(1);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = gate.run(async () => {
      order.push("first:start");
      await blocked;
      order.push("first:end");
    });
    const second = gate.run(async () => {
      order.push("second:start");
    });

    await Bun.sleep(5);
    expect(gate.active).toBe(1);
    expect(gate.waiting).toBe(1);
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(gate.active).toBe(0);
  });

  test("fails only the waiting call after its deadline", async () => {
    const gate = new ConcurrencyGate(1, { waitTimeoutMs: 20 });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.run(() => blocked);

    await expect(gate.run(async () => undefined)).rejects.toMatchObject({
      reason: "concurrency",
    });

    release();
    await first;
    expect(gate.active).toBe(0);
  });

  test("releases a slot when the task throws", async () => {
    const gate = new ConcurrencyGate(1);

    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(gate.active).toBe(0);
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  test("rejects a non-positive limit", () => {
    expect(() => new ConcurrencyGate(0)).toThrow("positive integer");
    expect(() => new ConcurrencyGate(1.5)).toThrow("positive integer");
  });
});

describe("broker budgets", () => {
  test("defaults match ADR 0009", () => {
    expect(DEFAULT_BROKER_LIMITS.maxConcurrentDb).toBe(2);
    expect(DEFAULT_BROKER_LIMITS.dbStatementsPerSecond).toBeGreaterThan(0);

    const budgets = createBrokerBudgets();
    expect(budgets.dbGate).toBeInstanceOf(ConcurrencyGate);
    expect(budgets.egressRate).toBeInstanceOf(TokenBucket);
  });

  test("BrokerLimitError carries the budget that ran out", () => {
    expect(new BrokerLimitError("rate", "slow down")).toMatchObject({
      name: "BrokerLimitError",
      reason: "rate",
      message: "slow down",
    });
  });
});
