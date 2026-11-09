import { afterEach, describe, expect, test } from "bun:test";
import { createPushHandler, createPushStore } from "./app.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function start() {
  const store = createPushStore();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createPushHandler(store) });
  servers.push(server);
  return { store, server, base: `http://127.0.0.1:${server.port}` };
}

describe("push mock", () => {
  test("captures push payloads and lists them", async () => {
    const { base } = start();

    const response = await fetch(`${base}/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hello", body: "World" }),
    });

    expect(response.status).toBe(201);

    const messages = (await (await fetch(`${base}/api/messages`)).json()) as Array<{
      body: { title: string };
    }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body.title).toBe("Hello");

    const ui = await (await fetch(`${base}/`)).text();
    expect(ui).toContain("Hello");
  });

  test("accepts non-JSON payloads", async () => {
    const { base } = start();

    await fetch(`${base}/push`, { method: "POST", body: "plain payload" });

    const messages = (await (await fetch(`${base}/api/messages`)).json()) as Array<{
      body: string;
    }>;
    expect(messages[0]?.body).toBe("plain payload");
  });
});
