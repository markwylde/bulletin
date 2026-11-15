/**
 * Hook guard for the UI rebuild (change `ui-rebuild`, ADR 0021): class names are free to change,
 * `data-*` hooks are the contract. Compares the data-* attributes rendered by each app's markup
 * against a base ref and lists the removed ones.
 *
 *   bun scripts/ui-hooks.ts [--base main]
 *
 * Exits 1 when a removed hook is still referenced by tests/e2e or by client code (non-markup
 * `.ts` files), because that reference would now find nothing.
 */
import { parseArgs } from "node:util";
import { $, Glob } from "bun";

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: { base: { type: "string", default: "main" } },
});
const BASE = args.base ?? "main";

interface Area {
  readonly name: string;
  /** Markup sources: templates and components that render hooks. */
  readonly markup: readonly string[];
}

const AREAS: readonly Area[] = [
  {
    name: "user",
    markup: [
      "packages/templates/themes/**/*.liquid",
      "apps/user-app/src/**/*.ts",
      "apps/user-app/src/**/*.astro",
      "packages/ui/src/**/*.tsx",
    ],
  },
  { name: "staff", markup: ["apps/staff-app/src/**/*.tsx", "packages/ui/src/**/*.tsx"] },
];

/** Code that looks hooks up rather than (only) rendering them. */
const CONSUMERS = [
  "tests/e2e/**/*.ts",
  "apps/user-app/src/**/*.ts",
  "packages/ui/src/**/*.ts",
  "packages/ui/src/**/*.tsx",
  "apps/staff-app/src/**/*.ts",
  "apps/staff-app/src/**/*.tsx",
  "packages/test-utils/src/**/*.ts",
];

const ATTRIBUTE = /\bdata-([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"{}$]*)"|'([^'{}$]*)'))?/g;

/** Hook names plus `name="literal"` pairs where the value is a plain literal. */
function hooksIn(source: string, into: Set<string>): void {
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = `data-${match[1]}`;
    into.add(name);
    const literal = match[2] ?? match[3];
    if (literal !== undefined && literal !== "" && /^[\w.:-]+$/.test(literal)) {
      into.add(`${name}="${literal}"`);
    }
  }
}

function isTest(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

async function currentFiles(patterns: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of patterns) {
    for await (const file of new Glob(pattern).scan({ cwd: ".", onlyFiles: true })) {
      if (!file.includes("node_modules") && !isTest(file)) files.add(file);
    }
  }
  return [...files];
}

async function baseFiles(patterns: readonly string[]): Promise<string[]> {
  const listing = (await $`git ls-tree -r --name-only ${BASE}`.quiet().text()).split("\n");
  const globs = patterns.map((pattern) => new Glob(pattern));
  return listing.filter((file) => file !== "" && !isTest(file) && globs.some((g) => g.match(file)));
}

async function hooksAtBase(patterns: readonly string[]): Promise<Set<string>> {
  const hooks = new Set<string>();
  for (const file of await baseFiles(patterns)) {
    hooksIn(await $`git show ${`${BASE}:${file}`}`.quiet().text(), hooks);
  }
  return hooks;
}

async function hooksNow(patterns: readonly string[]): Promise<Set<string>> {
  const hooks = new Set<string>();
  for (const file of await currentFiles(patterns)) {
    hooksIn(await Bun.file(file).text(), hooks);
  }
  return hooks;
}

/** Every file that mentions the hook by name in a selector or dataset lookup. */
async function referencesTo(hook: string, consumers: readonly string[]): Promise<string[]> {
  const name = hook.replace(/=.*$/, "");
  const literal = hook.includes("=") ? hook.slice(hook.indexOf("=") + 1).replaceAll('"', "") : null;
  const camel = name
    .slice("data-".length)
    .replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const hits: string[] = [];
  for (const file of consumers) {
    const text = await Bun.file(file).text();
    const byName =
      text.includes(`[${name}`) ||
      text.includes(`"${name}"`) ||
      text.includes(`'${name}'`) ||
      new RegExp(`dataset\\.${camel}\\b`).test(text);
    if (literal === null ? byName : byName && text.includes(literal)) hits.push(file);
  }
  return hits;
}

let failed = false;
const consumers: string[] = [];
for (const pattern of CONSUMERS) {
  for await (const file of new Glob(pattern).scan({ cwd: ".", onlyFiles: true })) {
    if (!file.includes("node_modules")) consumers.push(file);
  }
}

for (const area of AREAS) {
  const before = await hooksAtBase(area.markup);
  const after = await hooksNow(area.markup);
  const removed = [...before].filter((hook) => !after.has(hook)).sort();
  const added = [...after].filter((hook) => !before.has(hook)).length;

  console.log(
    `\n${area.name}: ${before.size} hooks at ${BASE}, ${after.size} now (+${added}, -${removed.length})`,
  );

  for (const hook of removed) {
    const refs = await referencesTo(hook, consumers);
    if (refs.length > 0) {
      failed = true;
      console.log(
        `  ✗ ${hook} removed but still used by ${refs.slice(0, 4).join(", ")}${refs.length > 4 ? ` +${refs.length - 4}` : ""}`,
      );
    } else {
      console.log(`  - ${hook} removed (unreferenced)`);
    }
  }
}

if (failed) {
  console.error("\nRemoved hooks are still referenced. Restore them or update their consumers.");
  process.exit(1);
}
