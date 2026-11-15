import { dirname, join } from "node:path";

/**
 * Self-hosted Inter (ADR 0021), served same-origin so the strict CSP (`font-src 'self'`) holds.
 * Public name → file inside the pinned `@fontsource-variable/inter` package. The latin subset
 * covers en/es/fr; latin-ext covers member names outside it.
 */
export const INTER_FILES: Readonly<Record<string, string>> = {
  "inter-var.woff2": "files/inter-latin-wght-normal.woff2",
  "inter-var-italic.woff2": "files/inter-latin-wght-italic.woff2",
  "inter-var-latin-ext.woff2": "files/inter-latin-ext-wght-normal.woff2",
  "inter-var-latin-ext-italic.woff2": "files/inter-latin-ext-wght-italic.woff2",
  "inter-license.txt": "LICENSE",
};

/** The URL prefix the font route answers; it is a non-page prefix in the middleware. */
export const FONT_PREFIX = "/fonts/";

/** One year and immutable: the files change only with the pinned package version. */
export const FONT_CACHE_CONTROL = "public, max-age=31536000, immutable";

let packageRoot: string | undefined;

function interPackageRoot(): string {
  // Resolved next to this module first (source runs, tests from the repo root), then from the
  // app directory, which is the process cwd in dev and in the production image when the SSR
  // bundle has inlined this module.
  packageRoot ??= dirname(resolveFrom([import.meta.dir, process.cwd()]));
  return packageRoot;
}

/** Absolute path for a public font name, or null when the name is not served. */
export function interFilePath(name: string): string | null {
  const relative = INTER_FILES[name];
  return relative === undefined ? null : join(interPackageRoot(), relative);
}

function resolveFrom(directories: readonly string[]): string {
  for (const directory of directories) {
    try {
      return Bun.resolveSync("@fontsource-variable/inter/package.json", directory);
    } catch {
      // Try the next directory.
    }
  }
  throw new Error("@fontsource-variable/inter is not installed for user-app");
}
