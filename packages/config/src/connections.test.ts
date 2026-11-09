import { describe, expect, test } from "bun:test";
import {
  assertConnectionBudget,
  ConnectionBudgetError,
  checkConnectionBudget,
  parseReplicas,
} from "./connections.ts";

describe("connection budget", () => {
  test("accepts the default shares on a normal Postgres", () => {
    const result = checkConnectionBudget({ maxConnections: 100 });

    expect(result.ok).toBe(true);
    expect(result.required).toBe(66);
    expect(result.available).toBe(90);
  });

  test("multiplies every share by declared replicas", () => {
    const result = checkConnectionBudget({ maxConnections: 100, replicas: { workers: 2 } });

    expect(result.required).toBe(82);
    expect(result.shares.find((share) => share.service === "workers")).toEqual({
      service: "workers",
      perReplica: 16,
      replicas: 2,
      total: 32,
    });
  });

  test("refuses an over-budget configuration and lists each service", () => {
    const result = checkConnectionBudget({ maxConnections: 50 });
    expect(result.ok).toBe(false);

    expect(() => assertConnectionBudget({ maxConnections: 50 })).toThrow(ConnectionBudgetError);

    let message = "";
    try {
      assertConnectionBudget({ maxConnections: 50 });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("user-api 11×1=11");
    expect(message).toContain("workers 16×1=16");
    expect(message).toContain("plugin-host 22×1=22");
  });

  test("parses replica overrides", () => {
    expect(parseReplicas("user-api=2,workers=3")).toEqual({ "user-api": 2, workers: 3 });
    expect(parseReplicas("unknown=4,user-api=nope")).toEqual({});
    expect(parseReplicas(undefined)).toEqual({});
  });
});
