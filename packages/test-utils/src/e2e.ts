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
  const viewport = resolveViewport(options.viewport);
  const profileDirectory =
    options.profileDirectory ?? (await mkdtemp(join(tmpdir(), "bulletin-webview-")));
  const ownsProfile = options.profileDirectory === undefined;

  let view: Bun.WebView | undefined;
  let lastError: unknown;

  try {
    for (let attempt = 0; attempt < 3 && view === undefined; attempt += 1) {
      Bun.WebView.closeAll();
      await Bun.sleep(25);

      try {
        const candidate = new Bun.WebView({
          backend: { type: "chrome", url: false },
          width: viewport.width,
          height: viewport.height,
          dataStore: { directory: profileDirectory },
        });

        await candidate.navigate(options.url);
        await candidate.cdp("Emulation.setDeviceMetricsOverride", {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: viewport.width < 500,
        });
        view = candidate;
      } catch (error) {
        lastError = error;
        Bun.WebView.closeAll();
        await Bun.sleep(100);
      }
    }

    if (view === undefined) {
      throw lastError instanceof Error ? lastError : new Error("Could not start Chrome");
    }

    return await run(view);
  } finally {
    view?.close();
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

export interface LoginAsOptions {
  readonly timeoutMs?: number;
}

async function authState(view: Bun.WebView): Promise<string | null> {
  try {
    return await view.evaluate<string | null>(
      "document.querySelector('[data-auth-state]')?.getAttribute('data-auth-state') ?? null",
    );
  } catch {
    return null;
  }
}

/** Selects a profile on the darkauth-mock login page and submits its card form. */
export async function chooseMockProfile(
  view: Bun.WebView,
  profile: string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitForSelector(view, 'form.card-form input[name="user"]', timeoutMs);

  const submitted = await view.evaluate<boolean>(`(() => {
    const input = [...document.querySelectorAll('form.card-form input[name="user"]')].find(
      (element) => element.value === ${JSON.stringify(profile)}
    );

    if (!input || !input.form) {
      return false;
    }

    input.form.requestSubmit();
    return true;
  })()`);

  if (!submitted) {
    throw new Error(`darkauth-mock has no profile with subject ${profile}`);
  }
}

/**
 * Logs a page in as one darkauth-mock profile. The app must expose
 * `[data-auth-state]` and `[data-login]`; the mock login page lists users as forms.
 */
export async function loginAs(
  view: Bun.WebView,
  profile: string,
  options: LoginAsOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const state = await authState(view);

    if (state === "authenticated") {
      return;
    }

    if (state === "guest" || state === "error") {
      break;
    }

    await Bun.sleep(50);
  }

  await waitForSelector(view, "[data-login]", timeoutMs);
  await view.evaluate('document.querySelector("[data-login]")?.click()');
  await chooseMockProfile(view, profile, timeoutMs);
  await waitForSelector(view, '[data-auth-state="authenticated"]', timeoutMs);
}
