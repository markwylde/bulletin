import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

interface PermissionBypass {
  readonly path: string;
  readonly tables: readonly string[];
}

const CONTENT_SQL =
  /\b(?:from|join|into|update)\s+core\.(forums|topics|posts|attachments|announcements|conversations|messages)\b/gi;

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function isPermissionRepository(file: SourceFile): boolean {
  return (
    file.path.startsWith("packages/domain/src/") &&
    file.path.endsWith("/repository.ts") &&
    /capability\.(has|read)\(|\bcan\(/.test(file.text)
  );
}

function isAllowed(file: SourceFile): boolean {
  return (
    file.path.startsWith("packages/domain/src/permissions/") ||
    file.path.startsWith("packages/db/src/seed/") ||
    // Staff-admin screens read forum definitions behind an ACP guard; they are not a public
    // content path.
    file.path.startsWith("apps/staff-api/src/") ||
    // The re-render worker only materialises stored HTML; it never serves a viewer.
    file.path === "packages/db/src/jobs/content.ts" ||
    // The attachment state machine updates lifecycle state by ID; it never reads content for
    // a viewer, and every download still goes through the permission repository (ADR 0019).
    file.path === "packages/storage/src/attachments.ts" ||
    isPermissionRepository(file)
  );
}

/**
 * ADR 0005: every reader of forum content goes through a permission-filtered repository
 * function. This finds SQL against content tables outside the permission internals and
 * repository modules, which is the shape of a bypass.
 */
export function findPermissionBypasses(files: readonly SourceFile[]): readonly PermissionBypass[] {
  const bypasses: PermissionBypass[] = [];

  for (const file of files) {
    if (isAllowed(file)) {
      continue;
    }

    const tables = new Set<string>();

    for (const match of file.text.matchAll(CONTENT_SQL)) {
      const table = match[1];

      if (table !== undefined) {
        tables.add(table.toLowerCase());
      }
    }

    if (tables.size > 0) {
      bypasses.push({ path: file.path, tables: [...tables].sort() });
    }
  }

  return bypasses;
}

async function readProductionSources(): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];

  for (const pattern of [
    "apps/**/*.ts",
    "apps/**/*.tsx",
    "packages/**/*.ts",
    "packages/**/*.tsx",
  ]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: ROOT, onlyFiles: true })) {
      const normalised = path.replaceAll("\\", "/");

      if (
        normalised.includes("/node_modules/") ||
        normalised.includes("/dist/") ||
        normalised.includes("/.astro/") ||
        normalised.endsWith(".test.ts") ||
        normalised.endsWith(".test.tsx")
      ) {
        continue;
      }

      files.push({
        path: normalised,
        text: await Bun.file(`${ROOT}${normalised}`).text(),
      });
    }
  }

  return files;
}

describe("permission-filtered repositories", () => {
  test("catches a planted content query outside a permission-filtered repository", () => {
    const bypasses = findPermissionBypasses([
      {
        path: "apps/user-app/src/leak.ts",
        text: "const rows = await sql`SELECT id FROM core.topics`;",
      },
      {
        path: "packages/domain/src/forums/repository.ts",
        text: "await sql`SELECT id FROM core.forums WHERE id = 1`; capability.read(id);",
      },
    ]);

    expect(bypasses).toEqual([{ path: "apps/user-app/src/leak.ts", tables: ["topics"] }]);
  });

  test("a repository that does not use the capability accessor is a bypass", () => {
    const bypasses = findPermissionBypasses([
      {
        path: "packages/domain/src/posts/repository.ts",
        text: "await sql`SELECT body FROM core.posts`;",
      },
    ]);

    expect(bypasses).toEqual([
      { path: "packages/domain/src/posts/repository.ts", tables: ["posts"] },
    ]);
  });

  test("production source has no content queries outside permission-filtered repositories", async () => {
    const bypasses = findPermissionBypasses(await readProductionSources());

    expect(bypasses).toEqual([]);
  }, 30_000);
});
