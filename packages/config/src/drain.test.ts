import { describe, expect, test } from "bun:test";
import { createDrainController } from "./drain.ts";

describe("drain controller", () => {
  test("waits for tracked work", async () => {
    const drain = createDrainController();
    const finish = drain.track();
    let done = false;
    const pending = drain.drain(500).then(() => {
      done = true;
    });

    await Bun.sleep(10);
    expect(done).toBe(false);
    expect(drain.draining).toBe(true);
    finish();
    await pending;
    expect(done).toBe(true);
  });

  test("enforces its deadline", async () => {
    const drain = createDrainController();
    drain.track();
    const started = Date.now();

    await drain.drain(20);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("does not double-decrement after repeated completion", async () => {
    const drain = createDrainController();
    const finish = drain.track();
    finish();
    finish();

    await drain.drain(20);
    expect(drain.draining).toBe(true);
  });
});
