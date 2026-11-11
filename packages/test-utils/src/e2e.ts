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
  /** Expected console errors (e.g. an intentional 403 refusal); uncaught errors always fail. */
  readonly allowConsoleErrors?: readonly RegExp[];
}

function resolveViewport(viewport: ViewportName | Viewport): Viewport {
  return typeof viewport === "string" ? VIEWPORTS[viewport] : viewport;
}

interface OpenPage {
  readonly view: Bun.WebView;
  readonly pageErrors: string[];
  readonly profileDirectory: string;
  readonly ownsProfile: boolean;
}

/** Opens one page with error capture. The caller owns the process-wide view lifecycle. */
async function openPage(options: PageOptions): Promise<OpenPage> {
  const viewport = resolveViewport(options.viewport);
  const profileDirectory =
    options.profileDirectory ?? (await mkdtemp(join(tmpdir(), "bulletin-webview-")));
  const ownsProfile = options.profileDirectory === undefined;
  const errors: string[] = [];
  const candidate = new Bun.WebView({
    backend: { type: "chrome", url: false },
    width: viewport.width,
    height: viewport.height,
    dataStore: { directory: profileDirectory },
  });

  // Set up the CDP session and exception/console capture before the real navigation.
  await candidate.navigate("about:blank");
  await candidate.cdp("Runtime.enable");
  await candidate.cdp("Log.enable");
  candidate.addEventListener<{
    readonly exceptionDetails?: {
      readonly text?: string;
      readonly exception?: { readonly description?: string };
    };
  }>("Runtime.exceptionThrown", (event) => {
    const details = event.data.exceptionDetails;
    errors.push(details?.exception?.description ?? details?.text ?? "Uncaught page exception");
  });
  const allowedConsoleError = (message: string): boolean =>
    (options.allowConsoleErrors ?? []).some((pattern) => pattern.test(message));
  candidate.addEventListener<{
    readonly type?: string;
    readonly args?: readonly { readonly value?: unknown; readonly description?: string }[];
  }>("Runtime.consoleAPICalled", (event) => {
    if (event.data.type !== "error") {
      return;
    }

    const message = (event.data.args ?? [])
      .map((arg) => String(arg.value ?? arg.description ?? ""))
      .join(" ");

    if (!allowedConsoleError(message)) {
      errors.push(message === "" ? "console.error" : message);
    }
  });
  candidate.addEventListener<{
    readonly entry?: {
      readonly level?: string;
      readonly text?: string;
      readonly url?: string;
    };
  }>("Log.entryAdded", (event) => {
    if (event.data.entry?.level === "error") {
      const entry = event.data.entry;
      const message = `${entry.text ?? "console error"}${entry.url === undefined ? "" : ` (${entry.url})`}`;

      if (!allowedConsoleError(message)) {
        errors.push(message);
      }
    }
  });

  await candidate.navigate(options.url);
  await candidate.cdp("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.width < 500,
  });

  return { view: candidate, pageErrors: errors, profileDirectory, ownsProfile };
}

async function closePage(page: OpenPage): Promise<void> {
  page.view.close();

  if (page.ownsProfile) {
    await rm(page.profileDirectory, { recursive: true, force: true });
  }
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
  let page: OpenPage | undefined;
  let lastError: unknown;

  try {
    for (let attempt = 0; attempt < 3 && page === undefined; attempt += 1) {
      Bun.WebView.closeAll();
      await Bun.sleep(25);

      try {
        page = await openPage(options);
      } catch (error) {
        lastError = error;
        Bun.WebView.closeAll();
        await Bun.sleep(100);
      }
    }

    if (page === undefined) {
      throw lastError instanceof Error ? lastError : new Error("Could not start Chrome");
    }

    const result = await run(page.view);

    if (page.pageErrors.length > 0) {
      throw new Error(`Page errors (uncaught or console):\n${page.pageErrors.join("\n")}`);
    }

    return result;
  } finally {
    if (page !== undefined) {
      await closePage(page);
    }

    Bun.WebView.closeAll();
  }
}

/**
 * Opens several independent pages (separate Chrome profiles, one process) and fails on any
 * uncaught or console error in any of them. Use for tests that must act in one page while
 * another stays open, e.g. staff revoking a member's session.
 */
export async function withPages<T>(
  options: Readonly<Record<string, PageOptions>>,
  run: (views: Readonly<Record<string, Bun.WebView>>) => Promise<T>,
): Promise<T> {
  let pages: Record<string, OpenPage> = {};
  let lastError: unknown;
  let opened = false;

  try {
    for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
      Bun.WebView.closeAll();
      await Bun.sleep(25);
      pages = {};

      try {
        for (const [name, pageOptions] of Object.entries(options)) {
          pages[name] = await openPage(pageOptions);
        }

        opened = true;
      } catch (error) {
        lastError = error;

        for (const page of Object.values(pages)) {
          await closePage(page);
        }

        pages = {};
        Bun.WebView.closeAll();
        await Bun.sleep(100);
      }
    }

    if (!opened) {
      throw lastError instanceof Error ? lastError : new Error("Could not start Chrome");
    }

    const views = Object.fromEntries(
      Object.entries(pages).map(([name, page]) => [name, page.view]),
    ) as Record<string, Bun.WebView>;
    const result = await run(views);
    const errors = Object.values(pages).flatMap((page) => page.pageErrors);

    if (errors.length > 0) {
      throw new Error(`Page errors (uncaught or console):\n${errors.join("\n")}`);
    }

    return result;
  } finally {
    for (const page of Object.values(pages)) {
      await closePage(page);
    }

    Bun.WebView.closeAll();
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

/** Polls a boolean JavaScript expression until it is true. */
export async function waitForExpression(
  view: Bun.WebView,
  expression: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      if (await view.evaluate<boolean>(expression)) {
        return;
      }
    } catch {
      // The document may still be navigating; retry until the timeout.
    }

    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for expression ${expression}`);
}

export async function screenshot(view: Bun.WebView, path: string): Promise<void> {
  const buffer = await view.screenshot({ encoding: "buffer" });
  await Bun.write(path, buffer);
}

export async function pageText(view: Bun.WebView): Promise<string> {
  return view.evaluate<string>("document.body?.innerText ?? ''");
}

/** Sets a controlled input/textarea/select value and fires the event React listens for. */
export async function setInputValue(
  view: Bun.WebView,
  selector: string,
  value: string,
): Promise<void> {
  const changed = await view.evaluate<boolean>(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement)) {
      return false;
    }
    const proto = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }));
    return true;
  })()`);

  if (!changed) {
    throw new Error(`Input not found: ${selector}`);
  }
}

export async function clickSelector(view: Bun.WebView, selector: string): Promise<void> {
  const clicked = await view.evaluate<boolean>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    element.click();
    return true;
  })()`);

  if (!clicked) {
    throw new Error(`Element not found: ${selector}`);
  }
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

/** Runs the login flow and expects the app to reject the identity (e.g. no ACP access). */
export async function loginAsRefused(
  view: Bun.WebView,
  profile: string,
  options: LoginAsOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;

  await waitForSelector(view, "[data-login]", timeoutMs);
  await view.evaluate('document.querySelector("[data-login]")?.click()');
  await chooseMockProfile(view, profile, timeoutMs);
  await waitForSelector(view, '[data-access-denied="session"]', timeoutMs);
}
