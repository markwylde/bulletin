import { fileURLToPath } from "node:url";
import { formatCatalogIssues } from "@bulletin/i18n/catalogs";
import { watchCatalogs } from "./i18n-watch.ts";

const separator = process.argv.indexOf("--");
// Bun removes the literal `--` separator, so the command starts at argv[2] either way.
const command = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);

if (command.length === 0) {
  console.error("Usage: bun scripts/dev-i18n.ts -- <app dev command>");
  process.exit(2);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const watcher = await watchCatalogs(root, {
  onRegenerate(result) {
    if (result.issues.length > 0) {
      console.error(formatCatalogIssues(result.issues));
    } else {
      console.log("i18n: merged catalogs regenerated");
    }
  },
});

const child = Bun.spawn(command, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

const stop = (signal: "SIGINT" | "SIGTERM"): void => {
  watcher.close();
  child.kill(signal);
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

process.exit(await child.exited);
