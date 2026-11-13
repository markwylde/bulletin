import { describe, expect, test } from "bun:test";
import { createLogger } from "@bulletin/config";
import {
  type DnsAddress,
  EgressDeniedError,
  type EgressDenyReason,
  type EgressFetch,
  type EgressLookup,
  EgressProxy,
  isBlockedAddress,
} from "./egress.ts";

const logger = createLogger({ service: "egress-test", level: "error", sink: () => {} });
const PUBLIC = [{ address: "93.184.216.34", family: 4 }] as const;
const PUBLIC_CDN = [{ address: "2606:4700:4700::1111", family: 6 }] as const;

interface Harness {
  readonly proxy: EgressProxy;
  readonly calls: Array<{
    readonly url: string;
    readonly init: RequestInit;
    readonly addresses: readonly DnsAddress[] | undefined;
  }>;
}

function createHarness(options: {
  readonly allowedHosts?: readonly string[];
  readonly addresses?: Readonly<Record<string, readonly DnsAddress[]>>;
  readonly respond?: (url: string, init: RequestInit) => Response | Promise<Response>;
  readonly maxRedirects?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}): Harness {
  const calls: Array<{
    url: string;
    init: RequestInit;
    addresses: readonly DnsAddress[] | undefined;
  }> = [];
  const lookup: EgressLookup = async (host) => options.addresses?.[host] ?? PUBLIC;
  const fetchImpl: EgressFetch = async (url, init, addresses) => {
    calls.push({ url, init, addresses });

    if (options.respond !== undefined) {
      return options.respond(url, init);
    }

    return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
  };
  const proxy = new EgressProxy({
    allowedHosts: options.allowedHosts ?? ["example.com"],
    logger,
    lookup,
    fetch: fetchImpl,
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
    ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
  });

  return { proxy, calls };
}

async function denied(
  promise: Promise<unknown>,
  reason?: EgressDenyReason,
): Promise<EgressDeniedError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EgressDeniedError);

    if (reason !== undefined) {
      expect((error as EgressDeniedError).reason).toBe(reason);
    }

    return error as EgressDeniedError;
  }

  throw new Error("Expected an EgressDeniedError");
}

describe("SSRF address classification", () => {
  test("blocks loopback, private, link-local, metadata and reserved ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.100.100.200",
      "127.0.0.1",
      "169.254.169.254",
      "169.254.170.2",
      "168.63.129.16",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.192",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fe80::1",
      "fec0::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::10.0.0.1",
      "not-an-ip",
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  test("allows public unicast addresses", () => {
    for (const address of [
      "93.184.216.34",
      "8.8.8.8",
      "172.32.0.1",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "64:ff9b::8.8.8.8",
    ]) {
      expect(isBlockedAddress(address)).toBe(false);
    }
  });
});

describe("egress allowlist and SSRF rules", () => {
  test("fetches an allowlisted host with manual redirects and no credentials", async () => {
    const { proxy, calls } = createHarness({});

    const response = await proxy.request({
      url: "https://example.com/data?x=1",
      headers: { accept: "text/plain", host: "evil.example" },
    });

    expect(response).toEqual({
      url: "https://example.com/data?x=1",
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({ redirect: "manual", credentials: "omit" });
    expect(calls[0]?.init.headers).toEqual({ accept: "text/plain" });
  });

  test("rejects hosts outside the allowlist without fetching", async () => {
    const { proxy, calls } = createHarness({});

    await denied(proxy.request({ url: "https://evil.example/" }), "host");
    expect(calls).toHaveLength(0);
  });

  test("rejects non-http schemes, credentials and non-standard ports", async () => {
    const { proxy, calls } = createHarness({});

    await denied(proxy.request({ url: "file:///etc/passwd" }), "scheme");
    await denied(proxy.request({ url: "ftp://example.com/file" }), "scheme");
    await denied(proxy.request({ url: "https://user:pass@example.com/" }), "credentials");
    await denied(proxy.request({ url: "https://example.com:8080/" }), "port");

    expect(calls).toHaveLength(0);
  });

  test("rejects IP address literals and private DNS answers", async () => {
    const { proxy, calls } = createHarness({
      addresses: {
        "example.com": [{ address: "10.0.0.1", family: 4 }],
        "metadata.example": [{ address: "169.254.169.254", family: 4 }],
        "mixed.example": [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      },
      allowedHosts: ["example.com", "metadata.example", "mixed.example"],
    });

    await denied(proxy.request({ url: "http://169.254.169.254/latest/meta-data" }), "address");
    await denied(proxy.request({ url: "https://[::1]/" }), "address");
    await denied(proxy.request({ url: "https://example.com/" }), "address");
    await denied(proxy.request({ url: "https://metadata.example/" }), "address");
    await denied(proxy.request({ url: "https://mixed.example/" }), "address");

    expect(calls).toHaveLength(0);
  });

  test("rejects a hostname that cannot be resolved", async () => {
    const lookupFailure = new EgressProxy({
      allowedHosts: ["missing.example"],
      logger,
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
      fetch: async () => {
        throw new Error("must not fetch");
      },
    });

    await denied(lookupFailure.request({ url: "https://missing.example/" }), "address");
  });
});

describe("egress redirects", () => {
  test("rejects a redirect to a host outside the allowlist", async () => {
    const { proxy, calls } = createHarness({
      respond: () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    });

    await denied(proxy.request({ url: "https://example.com/" }), "host");
    expect(calls).toHaveLength(1);
  });

  test("re-validates and follows a redirect to another allowlisted host", async () => {
    const { proxy, calls } = createHarness({
      allowedHosts: ["example.com", "cdn.example"],
      addresses: { "example.com": PUBLIC, "cdn.example": PUBLIC_CDN },
      respond: (url) =>
        url.includes("cdn.example")
          ? new Response("final", { status: 200, headers: { "content-type": "text/plain" } })
          : new Response(null, {
              status: 301,
              headers: { location: "https://cdn.example/file" },
            }),
    });

    const response = await proxy.request({ url: "https://example.com/start" });

    expect(response).toEqual({
      url: "https://cdn.example/file",
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "final",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.com/start",
      "https://cdn.example/file",
    ]);
  });

  test("rejects a redirect whose allowlisted host resolves to a private address", async () => {
    const { proxy, calls } = createHarness({
      allowedHosts: ["example.com", "internal.example"],
      addresses: {
        "example.com": PUBLIC,
        "internal.example": [{ address: "10.1.2.3", family: 4 }],
      },
      respond: () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://internal.example/admin" },
        }),
    });

    await denied(proxy.request({ url: "https://example.com/" }), "address");
    expect(calls).toHaveLength(1);
  });

  test("stops after the redirect limit", async () => {
    const { proxy } = createHarness({
      maxRedirects: 2,
      respond: (url) =>
        new Response(null, {
          status: 302,
          headers: { location: `${url}?again=1` },
        }),
    });

    await denied(proxy.request({ url: "https://example.com/" }), "redirect");
  });

  test("turns a 303 POST into a GET without a body", async () => {
    const { proxy, calls } = createHarness({
      respond: (_url, init) =>
        init.method === "POST"
          ? new Response(null, { status: 303, headers: { location: "/result" } })
          : new Response("done", { status: 200 }),
    });

    const response = await proxy.request({
      url: "https://example.com/submit",
      method: "POST",
      body: "payload",
    });

    expect(response.body).toBe("done");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://example.com/result");
    expect(calls[1]?.init.method).toBe("GET");
    expect(calls[1]?.init.body).toBeUndefined();
  });
});

describe("egress request and response limits", () => {
  test("rejects a request body over the cap", async () => {
    const { proxy, calls } = createHarness({ maxRequestBytes: 4 });

    await denied(
      proxy.request({
        url: "https://example.com/",
        method: "POST",
        body: "12345",
      }),
      "request",
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a response body over the cap", async () => {
    const { proxy } = createHarness({
      maxResponseBytes: 4,
      respond: () => new Response("12345", { status: 200 }),
    });

    await denied(proxy.request({ url: "https://example.com/" }), "response");
  });

  test("strips cookies from response headers", async () => {
    const { proxy } = createHarness({
      respond: () =>
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain", "set-cookie": "session=secret" },
        }),
    });

    const response = await proxy.request({ url: "https://example.com/" });
    expect(response.headers).toEqual({ "content-type": "text/plain" });
  });

  test("rejects methods other than GET, POST and HEAD", async () => {
    const { proxy, calls } = createHarness({});

    await denied(
      proxy.request({ url: "https://example.com/", method: "PUT", body: "x" }),
      "method",
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects invalid headers and strips hop-by-hop headers", async () => {
    const { proxy, calls } = createHarness({});

    await denied(
      proxy.request({
        url: "https://example.com/",
        headers: { accept: "ok\r\nx: y" },
      }),
      "header",
    );

    await proxy.request({
      url: "https://example.com/",
      headers: {
        accept: "text/plain",
        host: "evil.example",
        connection: "keep-alive",
        "x-request-id": "123",
      },
    });

    expect(calls[0]?.init.headers).toEqual({
      accept: "text/plain",
      "x-request-id": "123",
    });
  });

  test("pins the validated address across a second DNS answer", async () => {
    let lookups = 0;
    let pinned: readonly DnsAddress[] | undefined;
    const proxy = new EgressProxy({
      allowedHosts: ["example.com"],
      logger,
      lookup: async () => {
        lookups += 1;
        return lookups === 1 ? PUBLIC : [{ address: "127.0.0.1", family: 4 }];
      },
      fetch: async (_url, _init, addresses) => {
        pinned = addresses;
        return new Response("ok");
      },
    });

    await proxy.request({ url: "https://example.com/" });

    expect(lookups).toBe(1);
    expect(pinned).toEqual(PUBLIC);
  });

  test("maps fetch failures to a denial", async () => {
    const { proxy } = createHarness({
      respond: () => {
        throw new Error("socket reset");
      },
    });

    await denied(proxy.request({ url: "https://example.com/" }), "request");
  });
});
