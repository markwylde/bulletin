import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

const child = Bun.spawn(["bun", "test", "tests/e2e"], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...Bun.env,
    BULLETIN_E2E: "1",
    BULLETIN_BASE_URL: userBaseUrl(),
    BULLETIN_STAFF_BASE_URL: staffBaseUrl(),
  },
});

process.exit(await child.exited);
