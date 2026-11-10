import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Task 5.3: cache tags are written in exactly one place (`bumpCacheTags`). This rule keeps
// migrations (schema and one-off seed rows) and the cache package as the only exceptions.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ALLOWED = ["packages/cache/", "packages/db/migrations/"];
const WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+core\.cache_tags\b/i;
const SKIP = /(\.test\.[^/]+$|\.spec\.[^/]+$|\/node_modules\/|\/dist\/|\/\.astro\/)/;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

async function directTagWrites(): Promise<readonly Finding[]> {
  const findings: Finding[] = [];

  for (const pattern of ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: ROOT, onlyFiles: true })) {
      const file = path.replaceAll("\\", "/");

      if (SKIP.test(file) || ALLOWED.some((prefix) => file.startsWith(prefix))) {
        continue;
      }

      const lines = (await Bun.file(`${ROOT}/${file}`).text()).split("\n");

      for (const [index, line] of lines.entries()) {
        if (WRITE.test(line)) {
          findings.push({ file, line: index + 1, text: line.trim() });
        }
      }
    }
  }

  return findings;
}

describe("cache tag writes", () => {
  test("only packages/cache writes core.cache_tags", async () => {
    expect(await directTagWrites()).toEqual([]);
  });
});
