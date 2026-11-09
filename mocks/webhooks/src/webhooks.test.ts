import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createWebhookHandler, createWebhookStore } from "./app.ts";

const SECRET = "test-secret";
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function start() {
  const store = createWebhookStore();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createWebhookHandler(store, SECRET),
  });
  servers.push(server);
  return { store, base: `http://127.0.0.1:${server.port}` };
}

function signature(timestamp: string, body: string): string {
  return createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
}

describe("webhook mock", () => {
  test("marks a valid signature", async () => {
    const { base } = start();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ event: "post.created", id: 1 });

    const response = await fetch(`${base}/hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulletin-timestamp": timestamp,
        "x-bulletin-signature": signature(timestamp, body),
      },
      body,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "captured", signatureValid: true });

    const requests = (await (await fetch(`${base}/api/requests`)).json()) as Array<{
      signatureValid: boolean;
    }>;
    expect(requests[0]?.signatureValid).toBe(true);
  });

  test("marks a tampered body as invalid", async () => {
    const { base } = start();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ event: "post.created", id: 1 });

    await fetch(`${base}/hook`, {
      method: "POST",
      headers: {
        "x-bulletin-timestamp": timestamp,
        "x-bulletin-signature": signature(timestamp, body),
      },
      body: `${body}tampered`,
    });

    const ui = await (await fetch(`${base}/`)).text();
    expect(ui).toContain("invalid");
  });

  test("marks a missing signature", async () => {
    const { base } = start();

    await fetch(`${base}/hook`, { method: "POST", body: "{}" });

    const ui = await (await fetch(`${base}/`)).text();
    expect(ui).toContain("missing");
  });
});
