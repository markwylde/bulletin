import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

interface MockPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

export interface MockReference {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
  readonly text: string;
}

/**
 * Mock-only names and flags that must never leak into application code.
 * Configuration defaults live in `packages/config` and tests in `packages/test-utils`;
 * both are deliberately exempt (ADR 0002: only URLs and credentials differ).
 */
const MOCK_PATTERNS: readonly MockPattern[] = [
  { name: "darkauth-mock", pattern: /\bdarkauth-mock\b/ },
  { name: "mock-service", pattern: /\bmock-(?:s3|mail|push|webhooks|oembed|cdn|marketplace)\b/ },
  {
    name: "mock-service-port",
    pattern: /\b(?:s3|mail|push|webhooks|oembed|cdn|marketplace):\d{2,5}\b/,
  },
  {
    name: "mock-service-host",
    pattern: /\b(?:s3|mail|push|webhooks|oembed|cdn|marketplace)-mock\b/,
  },
  { name: "mock-path", pattern: /\/_mocks(?:\/|$)/ },
  { name: "mock-flag", pattern: /\bMOCK_[A-Z0-9_]+\b/ },
  { name: "mock-mode", pattern: /\b(?:USE_MOCKS|BULLETIN_MOCKS|MOCK_MODE)\b/ },
  { name: "mock-port", pattern: /\blocalhost:400[1-7]\b/ },
  { name: "mock-docker-host", pattern: /\bhost\.docker\.internal\b/ },
  {
    name: "mock-subdomain",
    pattern: /\b(?:s3|mail|push|webhooks|oembed|cdn|marketplace)\.localhost\b/,
  },
];

const SCAN_ROOTS = ["apps", "packages"] as const;
const EXEMPT_PREFIXES = ["apps/proxy/", "packages/config/", "packages/test-utils/"] as const;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".astro"] as const;

function isExempt(path: string): boolean {
  return (
    EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    path.includes("/node_modules/") ||
    path.includes("/dist/") ||
    path.includes("/.astro/") ||
    path.endsWith(".test.ts") ||
    path.endsWith(".spec.ts")
  );
}

function sourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Scans application packages for mock-only hostnames, ports, paths and flags. */
export async function findMockReferences(root: string): Promise<readonly MockReference[]> {
  const findings: MockReference[] = [];

  for (const scanRoot of SCAN_ROOTS) {
    const base = join(root, scanRoot);
    const exists = await directoryExists(base);
    if (!exists) {
      continue;
    }

    const glob = new Bun.Glob("**/*");

    for await (const path of glob.scan({ cwd: base, onlyFiles: true })) {
      const absolute = join(base, path);
      const relativePath = relative(root, absolute).split(sep).join("/");

      if (isExempt(relativePath) || !sourceFile(relativePath)) {
        continue;
      }

      const text = await Bun.file(absolute).text();
      const lines = text.split("\n");

      for (const [index, line] of lines.entries()) {
        for (const { name, pattern } of MOCK_PATTERNS) {
          if (pattern.test(line)) {
            findings.push({
              file: relativePath,
              line: index + 1,
              pattern: name,
              text: line.trim(),
            });
          }
        }
      }
    }
  }

  return findings;
}

const repositoryRoot = dirname(dirname(import.meta.dir));

describe("architecture: mock isolation", () => {
  test("application code does not reference mock-only hostnames or flags", async () => {
    expect(await findMockReferences(repositoryRoot)).toEqual([]);
  });

  test("the guard catches a planted violation", async () => {
    const plantedRoot = await mkdtemp(join(tmpdir(), "bulletin-mock-guard-"));
    const plantedFile = join(plantedRoot, "apps", "planted", "src", "index.ts");

    try {
      await mkdir(dirname(plantedFile), { recursive: true });
      await writeFile(
        plantedFile,
        'export const mail = "http://mail:4002";\nexport const flag = "USE_MOCKS";\n',
        "utf8",
      );

      const findings = await findMockReferences(plantedRoot);
      expect(findings.map((finding) => finding.pattern).sort()).toEqual([
        "mock-mode",
        "mock-service-port",
      ]);
    } finally {
      await rm(plantedRoot, { recursive: true, force: true });
    }
  });
});
