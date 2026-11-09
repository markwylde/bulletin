import { join } from "node:path";
import { findHardCodedStrings, formatHardCodedString } from "@bulletin/i18n/lint";

const IGNORED_DIRECTORIES = new Set([
  ".astro",
  ".claude",
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

export async function lintHardCodedStrings(
  root: string,
): Promise<ReturnType<typeof findHardCodedStrings>> {
  const findings: ReturnType<typeof findHardCodedStrings> = [];

  for (const pattern of ["apps/**/*.{tsx,jsx}", "packages/**/*.{tsx,jsx}"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      const normalised = path.replaceAll("\\", "/");

      if (normalised.split("/").some((part) => IGNORED_DIRECTORIES.has(part))) {
        continue;
      }

      if (normalised.includes(".test.") || normalised.includes(".spec.")) {
        continue;
      }

      findings.push(
        ...findHardCodedStrings(await Bun.file(join(root, normalised)).text(), normalised),
      );
    }
  }

  return findings.sort((left, right) => {
    const file = left.file.localeCompare(right.file);
    return file === 0 ? left.line - right.line || left.column - right.column : file;
  });
}

if (import.meta.main) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag === -1 ? process.cwd() : (process.argv[rootFlag + 1] ?? process.cwd());
  const findings = await lintHardCodedStrings(root);

  if (findings.length > 0) {
    console.error(findings.map(formatHardCodedString).join("\n"));
    console.error(`\ni18n: ${findings.length} hard-coded user-facing string(s) found`);
    process.exit(1);
  }

  console.log("i18n: no hard-coded JSX strings");
}
