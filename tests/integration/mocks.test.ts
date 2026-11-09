import { describe, expect, test } from "bun:test";

// Run against the running compose stack:
//   docker compose up -d
//   bun run test:integration

const ENABLED = Bun.env.BULLETIN_INTEGRATION === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const MOCKS = ["s3", "mail", "push", "webhooks", "oembed", "marketplace"] as const;

integrationDescribe("local mocks through the proxy", () => {
  for (const name of MOCKS) {
    test(`${name} answers its health endpoint`, async () => {
      const response = await fetch(`http://bulletin.localhost:8080/_mocks/${name}/health`);

      expect(response.status).toBe(200);
    });

    test(`${name} exposes its inspection UI`, async () => {
      const response = await fetch(`http://bulletin.localhost:8080/_mocks/${name}/`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    });
  }

  test("the CDN mock answers health and exposes its inspector", async () => {
    const health = await fetch("http://bulletin.localhost:8080/_mocks/cdn/health");
    expect(health.status).toBe(200);

    const ui = await fetch("http://bulletin.localhost:8080/_mocks/cdn/__ui");
    expect(ui.status).toBe(200);
  });

  test("S3 round-trips through the proxy with a presigned upload", async () => {
    const client = new Bun.S3Client({
      endpoint: "http://bulletin.localhost:8080/_mocks/s3",
      bucket: "bulletin",
      accessKeyId: "bulletin",
      secretAccessKey: "bulletin-secret",
      region: "us-east-1",
    });
    const key = `test/${crypto.randomUUID()}`;

    try {
      await client.write(key, "integration storage", { type: "text/plain" });
      expect(await client.file(key).text()).toBe("integration storage");

      const upload = client.presign(`${key}-presigned`, { method: "PUT", expiresIn: 60 });
      const response = await fetch(upload, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "presigned integration",
      });

      expect(response.status).toBe(200);
      expect(await client.file(`${key}-presigned`).text()).toBe("presigned integration");
    } finally {
      await client.delete(key);
      await client.delete(`${key}-presigned`);
    }
  });
});
