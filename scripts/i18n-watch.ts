import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type CatalogCheckResult, checkCatalogs } from "@bulletin/i18n/catalogs";

const DEBOUNCE_MS = 50;

export interface CatalogWatcher {
  close(): void;
}

export interface CatalogWatcherOptions {
  onRegenerate?: (result: CatalogCheckResult) => void;
}

async function catalogDirectories(root: string): Promise<string[]> {
  const directories: string[] = [];

  for (const kind of ["apps", "packages"] as const) {
    let owners: string[];

    try {
      owners = (await readdir(join(root, kind), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const owner of owners) {
      const directory = join(root, kind, owner, "i18n");

      try {
        if ((await stat(directory)).isDirectory()) {
          directories.push(directory);
        }
      } catch {
        // Not every app or package has a catalog.
      }
    }
  }

  return directories;
}

async function regenerate(root: string): Promise<CatalogCheckResult> {
  return checkCatalogs({ root, write: true });
}

/**
 * Regenerates the merged app catalogs on every source catalog change. The dev wrapper runs this
 * next to Astro/Vite so compose watch only has to sync the source JSON files.
 */
export async function watchCatalogs(
  root: string,
  options: CatalogWatcherOptions = {},
): Promise<CatalogWatcher> {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];

  const run = async (): Promise<void> => {
    let result: CatalogCheckResult;

    try {
      result = await regenerate(root);
    } catch (error) {
      console.error(`i18n: regeneration failed: ${error instanceof Error ? error.message : error}`);
      return;
    }

    options.onRegenerate?.(result);
  };

  await run();

  for (const directory of await catalogDirectories(root)) {
    watchers.push(
      watch(directory, { persistent: true }, (_event, filename) => {
        if (closed || filename?.toString().includes("merged") === true) {
          return;
        }

        if (timer !== undefined) {
          clearTimeout(timer);
        }

        timer = setTimeout(() => {
          void run();
        }, DEBOUNCE_MS);
      }),
    );
  }

  return {
    close() {
      closed = true;

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}
