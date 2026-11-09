import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lintHardCodedStrings } from "./lint-i18n-strings.ts";

const roots: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bulletin-i18n-lint-"));
  roots.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await Bun.write(fullPath, contents);
  }

  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("hard-coded string lint", () => {
  test("flags a planted JSX literal and exits non-zero", async () => {
    const root = await fixture({
      "apps/forum/src/Page.tsx":
        "export function Page() { return <h1>Welcome to the forum</h1>; }\n",
    });

    const findings = await lintHardCodedStrings(root);
    expect(findings).toHaveLength(1);

    const process_ = Bun.spawn(["bun", "scripts/lint-i18n-strings.ts", "--root", root], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await process_.exited).toBe(1);
  });

  test("passes translated components and skips tests", async () => {
    const root = await fixture({
      "apps/forum/src/Page.tsx":
        'export function Page() { return <h1>{t(locale, "forum.title")}</h1>; }\n',
      "packages/ui/src/Button.test.tsx": "export const fixture = <button>Click me</button>;\n",
    });

    expect(await lintHardCodedStrings(root)).toEqual([]);
  });
});
