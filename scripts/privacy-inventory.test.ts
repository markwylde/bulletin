import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPrivacyInventory,
  DEFAULT_MIGRATIONS_DIR,
  INVENTORY_PATH,
} from "./privacy-inventory.ts";

const temporaryDirectories: string[] = [];

async function fixture(
  migrations: readonly string[],
  inventoryRows: readonly string[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bulletin-privacy-"));
  temporaryDirectories.push(root);
  await Bun.write(join(root, DEFAULT_MIGRATIONS_DIR, "0001_test.sql"), migrations.join("\n"));
  await Bun.write(
    join(root, INVENTORY_PATH),
    [
      "# Personal-data inventory",
      "",
      "## Database columns",
      "",
      "| Table | Column | Class | Purpose | Retention | Access | Export | Erasure |",
      "|---|---|---|---|---|---|---|---|",
      ...inventoryRows,
      "",
      "## Storage and other locations",
      "",
      "| Location | Class |",
      "|---|---|",
      "| `exports/<uuid>.zip` | personal-content |",
    ].join("\n"),
  );
  return root;
}

function row(table: string, column: string, className = "personal-content"): string {
  return `| \`${table}\` | \`${column}\` | ${className} | Test | Test | Test | Test | Test |`;
}

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("privacy inventory check", () => {
  test("accepts a tagged column that is listed with the same class", async () => {
    const root = await fixture(
      ["COMMENT ON COLUMN core.members.display_name IS '@personal class=personal-content';"],
      [row("core.members", "display_name")],
    );

    expect(await checkPrivacyInventory({ root })).toEqual([]);
  });

  test("fails on a planted unlisted personal column, naming it", async () => {
    const root = await fixture(
      [
        "COMMENT ON COLUMN core.members.display_name IS '@personal class=personal-content';",
        "COMMENT ON COLUMN core.members.email IS '@personal class=restricted';",
      ],
      [row("core.members", "display_name")],
    );

    const issues = await checkPrivacyInventory({ root });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "unlisted", column: "core.members.email" });
    expect(issues[0]?.message).toContain("core.members.email");
  });

  test("fails when a listed column has no tag, or the classes disagree", async () => {
    const root = await fixture(
      ["COMMENT ON COLUMN core.members.display_name IS '@personal class=personal-content';"],
      [
        row("core.members", "display_name", "restricted"),
        row("core.members", "last_active_at", "derived"),
      ],
    );

    const issues = await checkPrivacyInventory({ root });

    expect(issues.map((issue) => issue.code).sort()).toEqual(["class_mismatch", "untagged"]);
    expect(issues.map((issue) => issue.column).sort()).toEqual([
      "core.members.display_name",
      "core.members.last_active_at",
    ]);
  });

  test("the repository's own migrations and inventory agree", async () => {
    const root = join(import.meta.dir, "..");
    expect(await checkPrivacyInventory({ root })).toEqual([]);
  });
});
