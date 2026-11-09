const baseUrl = Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080";
const staffBaseUrl =
  Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080";

const child = Bun.spawn(["bun", "test", "tests/e2e"], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...Bun.env,
    BULLETIN_E2E: "1",
    BULLETIN_BASE_URL: baseUrl,
    BULLETIN_STAFF_BASE_URL: staffBaseUrl,
  },
});

process.exit(await child.exited);
