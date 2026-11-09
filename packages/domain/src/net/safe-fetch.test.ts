import { afterEach, describe, expect, test } from "bun:test";
import { isBlockedAddress } from "./address.ts";
import { createSafeFetch, SafeFetchError } from "./safe-fetch.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  const port = server.port;

  if (port === undefined) {
    throw new Error("Bun.serve did not assign a port");
  }

  servers.push(server);
  return { server, port, base: `http://127.0.0.1:${port}` };
}

function localFetch(overrides: Parameters<typeof createSafeFetch>[0] = {}) {
  return createSafeFetch({ devAllow: ["127.0.0.1"], ...overrides });
}

describe("blocked address ranges", () => {
  const blocked = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.10",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:8.8.8.8",
    "::8.8.8.8",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2001:db8::1",
    "2001:2::1",
    "3fff::1",
    "100::1",
  ];

  for (const address of blocked) {
    test(`${address} is blocked`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }

  test("public addresses are allowed", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("1.1.1.1")).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("safeFetch", () => {
  test("blocks loopback without a dev allowlist", async () => {
    const { base } = serve(() => new Response("ok"));
    const fetch = createSafeFetch();

    await expect(fetch(base)).rejects.toMatchObject({ code: "blocked_address" });
  });

  test("allows an explicitly allowlisted dev host", async () => {
    const { base } = serve(() => new Response("hello"));
    const fetch = localFetch();

    const response = await fetch(base);
    expect(await response.text()).toBe("hello");
  });

  test("rejects a dev allowlist in production", () => {
    expect(() => createSafeFetch({ nodeEnv: "production", devAllow: ["localhost"] })).toThrow(
      SafeFetchError,
    );
  });

  test("requires HTTPS in production", async () => {
    const fetch = createSafeFetch({ nodeEnv: "production" });

    await expect(fetch("http://example.com")).rejects.toMatchObject({ code: "https_required" });
  });

  test("pins the first resolved address and never re-resolves", async () => {
    const { port } = serve(() => new Response("pinned"));
    let calls = 0;
    const fetch = createSafeFetch({
      devAllow: ["rebind.test"],
      resolve: async () => {
        calls += 1;
        return calls === 1
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "10.0.0.1", family: 4 }];
      },
    });

    const response = await fetch(`http://rebind.test:${port}/`);
    expect(await response.text()).toBe("pinned");
    expect(calls).toBe(1);
  });

  test("re-checks every redirect target", async () => {
    const destination = serve(() => new Response("secret"));
    const redirector = serve(
      () => new Response(null, { status: 302, headers: { location: destination.base } }),
    );
    const fetch = createSafeFetch({
      devAllow: ["redirect.test"],
      maxRedirects: 3,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    await expect(fetch(`http://redirect.test:${redirector.port}/`)).rejects.toMatchObject({
      code: "blocked_address",
    });
  });

  test("follows an allowed redirect", async () => {
    let port = 0;
    const server = serve((request) => {
      const url = new URL(request.url);
      return url.pathname === "/final"
        ? new Response("final")
        : new Response(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${port}/final` },
          });
    });
    port = server.port;
    const fetch = localFetch({ maxRedirects: 2 });

    const response = await fetch(`${server.base}/start`);
    expect(await response.text()).toBe("final");
  });

  test("stops after the redirect limit", async () => {
    const server = serve(() => new Response(null, { status: 302, headers: { location: "/loop" } }));
    const fetch = localFetch({ maxRedirects: 1 });

    await expect(fetch(`${server.base}/loop`)).rejects.toMatchObject({
      code: "too_many_redirects",
    });
  });

  test("enforces the response size cap", async () => {
    const server = serve(() => new Response("0123456789"));
    const fetch = localFetch({ maxBytes: 5 });

    await expect(fetch(server.base)).rejects.toMatchObject({ code: "body_too_large" });
  });

  test("enforces the timeout", async () => {
    const server = serve(async () => {
      await Bun.sleep(200);
      return new Response("late");
    });
    const fetch = localFetch({ timeoutMs: 20 });

    await expect(fetch(server.base)).rejects.toMatchObject({ code: "timeout" });
  });

  test("forwards method, body and host", async () => {
    const server = serve(async (request) =>
      Response.json({
        method: request.method,
        body: await request.text(),
        host: request.headers.get("host"),
      }),
    );
    const fetch = localFetch();

    const response = await fetch(server.base, { method: "POST", body: "payload" });
    expect(await response.json()).toEqual({
      method: "POST",
      body: "payload",
      host: new URL(server.base).host,
    });
  });

  test("does not construct bodies for 204, 205 or 304", async () => {
    for (const status of [204, 205, 304]) {
      const server = serve(() => new Response(null, { status }));
      const fetch = localFetch();

      const response = await fetch(server.base);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    }
  });

  test("strips credentials on cross-origin redirects", async () => {
    const destination = serve((request) =>
      Response.json({
        authorization: request.headers.get("authorization"),
        cookie: request.headers.get("cookie"),
        apiKey: request.headers.get("x-api-key"),
      }),
    );
    const redirector = serve(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `${destination.base}/target` },
        }),
    );
    const fetch = localFetch({ maxRedirects: 1 });

    const response = await fetch(redirector.base, {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-api-key": "key",
      },
    });

    expect(await response.json()).toEqual({
      authorization: null,
      cookie: null,
      apiKey: null,
    });
  });

  test("keeps credentials on same-origin redirects", async () => {
    let port = 0;
    const server = serve((request) =>
      new URL(request.url).pathname === "/final"
        ? Response.json({ authorization: request.headers.get("authorization") })
        : new Response(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${port}/final` },
          }),
    );
    port = server.port;
    const fetch = localFetch({ maxRedirects: 1 });

    const response = await fetch(`${server.base}/start`, {
      headers: { authorization: "Bearer secret" },
    });

    expect(await response.json()).toEqual({ authorization: "Bearer secret" });
  });

  test("blocks a host whose DNS answer includes a private address", async () => {
    const fetch = createSafeFetch({
      resolve: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    });

    await expect(fetch("http://mixed.test")).rejects.toMatchObject({ code: "blocked_address" });
  });
});
