import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VIEWPORTS = {
  mobile360: { width: 360, height: 780 },
  mobile390: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;
export type Viewport = (typeof VIEWPORTS)[ViewportName];

export interface PageOptions {
  readonly url: string;
  readonly viewport: ViewportName | Viewport;
  readonly profileDirectory?: string;
}

function resolveViewport(viewport: ViewportName | Viewport): Viewport {
  return typeof viewport === "string" ? VIEWPORTS[viewport] : viewport;
}

/**
 * Opens a headless Chrome page with an isolated temporary profile and always cleans up.
 * E2E tests must run serially: Chrome is process-wide and closing all views resets its
 * profile, which is what makes "temporary profile per test" possible.
 */
export async function withPage<T>(
  options: PageOptions,
  run: (view: Bun.WebView) => Promise<T>,
): Promise<T> {
  Bun.WebView.closeAll();

  const viewport = resolveViewport(options.viewport);
  const profileDirectory =
    options.profileDirectory ?? (await mkdtemp(join(tmpdir(), "bulletin-webview-")));
  const ownsProfile = options.profileDirectory === undefined;

  const view = new Bun.WebView({
    backend: { type: "chrome", url: false },
    width: viewport.width,
    height: viewport.height,
    dataStore: { directory: profileDirectory },
  });

  try {
    await view.navigate(options.url);
    await view.cdp("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width < 500,
    });
    return await run(view);
  } finally {
    view.close();
    Bun.WebView.closeAll();

    if (ownsProfile) {
      await rm(profileDirectory, { recursive: true, force: true });
    }
  }
}

export async function waitForSelector(
  view: Bun.WebView,
  selector: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const found = await view.evaluate<boolean>(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      );

      if (found) {
        return;
      }
    } catch {
      // The document may still be navigating; retry until the timeout.
    }

    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for selector ${selector}`);
}

export async function screenshot(view: Bun.WebView, path: string): Promise<void> {
  const buffer = await view.screenshot({ encoding: "buffer" });
  await Bun.write(path, buffer);
}

export async function pageText(view: Bun.WebView): Promise<string> {
  return view.evaluate<string>("document.body?.innerText ?? ''");
}

export async function waitForText(
  view: Bun.WebView,
  text: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if ((await pageText(view)).includes(text)) {
      return;
    }

    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for text ${text}`);
}
