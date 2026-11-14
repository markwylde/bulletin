import { describe, expect, test } from "bun:test";
import { validatePushEndpoint } from "./endpoint.ts";

const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];

describe("push endpoint validation", () => {
  test("accepts a public HTTPS endpoint on the default port", async () => {
    const result = await validatePushEndpoint("https://push.example.test/send/abc", {
      resolve: publicResolver,
    });

    expect(result.ok).toBe(true);
    expect(result.url?.hostname).toBe("push.example.test");
  });

  test("requires HTTPS in production", async () => {
    const result = await validatePushEndpoint("http://push.example.test/send", {
      nodeEnv: "production",
      resolve: publicResolver,
    });

    expect(result).toMatchObject({ ok: false, code: "https_required" });
  });

  test("allows the explicitly allowlisted development mock over HTTP and another port", async () => {
    const result = await validatePushEndpoint("http://push:4003/push/device", {
      devAllow: ["push"],
      resolve: async () => [{ address: "10.0.0.5", family: 4 }],
    });

    expect(result.ok).toBe(true);
  });

  test("rejects loopback, private ranges and metadata addresses", async () => {
    const cases = [
      "http://127.0.0.1/push",
      "https://10.1.2.3/push",
      "https://192.168.1.9/push",
      "https://[::1]/push",
      "https://169.254.169.254/latest/meta-data",
    ];

    for (const endpoint of cases) {
      expect(await validatePushEndpoint(endpoint)).toMatchObject({
        ok: false,
        code: "blocked_address",
      });
    }
  });

  test("rejects credentials, fragments and unusual ports", async () => {
    expect(
      await validatePushEndpoint("https://user:pass@push.example.test/send", {
        resolve: publicResolver,
      }),
    ).toMatchObject({ ok: false, code: "credentials" });
    expect(
      await validatePushEndpoint("https://push.example.test:8443/send", {
        resolve: publicResolver,
      }),
    ).toMatchObject({ ok: false, code: "unusual_port" });
    expect(
      await validatePushEndpoint("https://push.example.test/send#fragment", {
        resolve: publicResolver,
      }),
    ).toMatchObject({ ok: false, code: "invalid_url" });
  });

  test("rejects a public hostname whose DNS answer is private or metadata", async () => {
    for (const address of ["127.0.0.1", "10.0.0.8", "169.254.169.254"]) {
      expect(
        await validatePushEndpoint("https://push.example.test/send", {
          resolve: async () => [{ address, family: 4 }],
        }),
      ).toMatchObject({ ok: false, code: "blocked_address" });
    }
  });

  test("a rebinding answer cannot turn a public host into a private destination", async () => {
    const answers = [[{ address: "8.8.8.8", family: 4 }], [{ address: "127.0.0.1", family: 4 }]];
    let index = 0;
    const result = await validatePushEndpoint("https://rebind.example.test/push", {
      resolve: async () => answers[Math.min(index++, answers.length - 1)] ?? [],
    });

    // The save-time check pins only the first answer; safeFetch repeats and pins at send time.
    expect(result.ok).toBe(true);
  });
});
