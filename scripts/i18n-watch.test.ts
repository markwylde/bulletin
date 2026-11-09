import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CatalogWatcher, watchCatalogs } from "./i18n-watch.ts";

const roots: string[] = [];
const watchers: CatalogWatcher[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

async function fixture(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bulletin-i18n-watch-"));
  roots.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await Bun.write(
      fullPath,
      typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`,
    );
  }

  return root;
}

async function waitFor(read: () => Promise<string>, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if ((await read()) === expected) {
      return;
    }

    await Bun.sleep(25);
  }

  throw new Error(`Timed out waiting for ${expected}`);
}

afterEach(async () => {
  for (const watcher of watchers.splice(0)) {
    watcher.close();
  }

  for (const server of servers.splice(0)) {
    server.stop(true);
  }

  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("catalog watcher", () => {
  test("regenerates merged catalogs when a translation is edited", async () => {
    const root = await fixture({
      "apps/forum/i18n/en.json": { greeting: "Hello" },
      "apps/forum/i18n/es.json": { greeting: "Hola" },
      "apps/forum/i18n/fr.json": { greeting: "Bonjour" },
      "apps/forum/src/page.ts": 't("greeting");\n',
    });

    const merged = join(root, "apps/forum/i18n/merged/en.json");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        const catalog = (await Bun.file(merged).json()) as Record<string, string>;
        return new Response(catalog.greeting ?? "missing");
      },
    });
    servers.push(server);

    watchers.push(await watchCatalogs(root));

    const read = async (): Promise<string> =>
      (await fetch(`http://127.0.0.1:${server.port}`)).text();

    expect(await read()).toBe("Hello");

    await Bun.write(join(root, "apps/forum/i18n/en.json"), '{\n  "greeting": "Hi"\n}\n');

    await waitFor(read, "Hi");
  });
});
