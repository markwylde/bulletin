import { readdirSync } from "node:fs";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

/**
 * Runs the browser E2E suite. `--shard=<index>/<total>` (1-based) runs every total-th file,
 * so CI can split the suite across parallel jobs, each with its own stack.
 */
function shardFiles(argv: readonly string[]): string[] {
  const flag = argv.find((arg) => arg.startsWith("--shard="));

  if (flag === undefined) {
    return ["tests/e2e"];
  }

  const match = /^--shard=(\d+)\/(\d+)$/.exec(flag);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);

  if (match === null || total < 1 || index < 1 || index > total) {
    throw new Error(`Invalid ${flag}; expected --shard=<index>/<total> with 1 <= index <= total`);
  }

  const files = readdirSync("tests/e2e")
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => `tests/e2e/${name}`);
  const picked = files.filter((_, position) => position % total === index - 1);

  console.log(`E2E shard ${index}/${total}: ${picked.length} of ${files.length} files`);
  return picked;
}

const files = shardFiles(process.argv.slice(2));

if (files.length === 0) {
  process.exit(0);
}

const child = Bun.spawn(["bun", "test", ...files], {
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
