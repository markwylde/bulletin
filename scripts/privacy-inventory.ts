import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The personal-data inventory check (ADR 0012; privacy-gdpr task 1.1).
 *
 * Every migration tags personal columns with `COMMENT ON COLUMN … IS '@personal class=…'`.
 * `docs/privacy/inventory.md` is the human-readable copy of the same list. This checker makes
 * the two sides agree, so a migration cannot add a personal column without documenting it.
 */

export const INVENTORY_PATH = "docs/privacy/inventory.md";
export const DEFAULT_MIGRATIONS_DIR = "packages/db/migrations";

export const PERSONAL_CLASSES = [
  "restricted",
  "personal-content",
  "security-record",
  "derived",
] as const;

export type PersonalClass = (typeof PERSONAL_CLASSES)[number];

export interface InventoryEntry {
  readonly table: string;
  readonly column: string;
  readonly className: string;
}

export interface PrivacyInventoryIssue {
  readonly code: "unlisted" | "untagged" | "class_mismatch" | "invalid_class" | "duplicate";
  readonly column: string;
  readonly message: string;
}

export interface PrivacyInventoryOptions {
  readonly root?: string;
  readonly migrationsDir?: string;
  readonly inventoryPath?: string;
}

const COMMENT_PATTERN =
  /COMMENT\s+ON\s+COLUMN\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s+IS\s+'@personal\s+class=([a-z-]+)'/g;
const INVENTORY_ROW =
  /^\|\s*`([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)`\s*\|\s*`([a-z_][a-z0-9_]*)`\s*\|\s*([a-z-]+)\s*\|/;

/** Parses every `@personal` column tag from the committed migrations. */
export async function readPersonalComments(migrationsDir: string): Promise<Map<string, string>> {
  const tags = new Map<string, string>();
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = await Bun.file(join(migrationsDir, file)).text();

    for (const match of sql.matchAll(COMMENT_PATTERN)) {
      const column = match[1];
      const className = match[2];

      if (column === undefined || className === undefined) {
        continue;
      }

      const existing = tags.get(column);

      if (existing !== undefined && existing !== className) {
        throw new Error(`${column} is tagged as both ${existing} and ${className} in ${file}`);
      }

      tags.set(column, className);
    }
  }

  return tags;
}

/** Parses the database-column table from the inventory document. */
export async function readInventory(inventoryPath: string): Promise<Map<string, string>> {
  const markdown = await Bun.file(inventoryPath).text();
  const entries = new Map<string, string>();
  const duplicates = new Set<string>();
  let inDatabaseTable = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      inDatabaseTable = line.trim() === "## Database columns";
      continue;
    }

    if (!inDatabaseTable) {
      continue;
    }

    const match = INVENTORY_ROW.exec(line);

    if (match === null) {
      continue;
    }

    const table = match[1];
    const column = match[2];
    const className = match[3];

    if (table === undefined || column === undefined || className === undefined) {
      continue;
    }

    const key = `${table}.${column}`;

    if (entries.has(key)) {
      duplicates.add(key);
    }

    entries.set(key, className);
  }

  if (duplicates.size > 0) {
    throw new Error(`duplicate inventory rows: ${[...duplicates].sort().join(", ")}`);
  }

  return entries;
}

/** Compares the migration tags with the inventory table. */
export async function checkPrivacyInventory(
  options: PrivacyInventoryOptions = {},
): Promise<PrivacyInventoryIssue[]> {
  const root = options.root ?? process.cwd();
  const migrationsDir = join(root, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  const inventoryPath = join(root, options.inventoryPath ?? INVENTORY_PATH);
  const tags = await readPersonalComments(migrationsDir);
  let inventory: Map<string, string>;

  try {
    inventory = await readInventory(inventoryPath);
  } catch (error) {
    return [
      {
        code: "untagged",
        column: INVENTORY_PATH,
        message: `${INVENTORY_PATH} is missing or unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    ];
  }

  const issues: PrivacyInventoryIssue[] = [];

  for (const [column, className] of [...tags].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!(PERSONAL_CLASSES as readonly string[]).includes(className)) {
      issues.push({
        code: "invalid_class",
        column,
        message: `${column} has unknown @personal class "${className}" (expected ${PERSONAL_CLASSES.join(", ")})`,
      });
      continue;
    }

    const documented = inventory.get(column);

    if (documented === undefined) {
      issues.push({
        code: "unlisted",
        column,
        message: `${column} is tagged ${className} but is missing from ${INVENTORY_PATH}`,
      });
      continue;
    }

    if (documented !== className) {
      issues.push({
        code: "class_mismatch",
        column,
        message: `${column} is tagged ${className} but ${INVENTORY_PATH} lists ${documented}`,
      });
    }
  }

  for (const [column, className] of [...inventory].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!tags.has(column)) {
      issues.push({
        code: "untagged",
        column,
        message: `${column} is listed as ${className} in ${INVENTORY_PATH} but has no @personal comment`,
      });
    }
  }

  return issues;
}

export function formatInventoryIssues(issues: readonly PrivacyInventoryIssue[]): string {
  return issues.map((issue) => `privacy: ${issue.message}`).join("\n");
}

if (import.meta.main) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag === -1 ? process.cwd() : (process.argv[rootFlag + 1] ?? process.cwd());
  const issues = await checkPrivacyInventory({ root });

  if (issues.length > 0) {
    console.error(formatInventoryIssues(issues));
    console.error(`\nprivacy: ${issues.length} inventory problem(s) found`);
    process.exit(1);
  }

  console.log("privacy: personal-data inventory OK");
}
