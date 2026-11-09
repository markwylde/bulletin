import { checkCatalogs, formatCatalogIssues } from "@bulletin/i18n/catalogs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const rootFlag = args.indexOf("--root");
const root = rootFlag === -1 ? process.cwd() : (args[rootFlag + 1] ?? process.cwd());

const result = await checkCatalogs({ root, write });

if (result.issues.length > 0) {
  console.error(formatCatalogIssues(result.issues));
  console.error(`\ni18n: ${result.issues.length} catalog problem(s) found`);
  process.exit(1);
}

const locales =
  result.sources.length === 0 ? "no catalog files yet" : `${result.sources.length} files`;
console.log(`i18n: catalogs OK (${locales}${write ? ", merged catalogs written" : ""})`);
