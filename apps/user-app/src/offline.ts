import { createServerT, type Locale } from "@bulletin/i18n";
import { USER_CATALOGS } from "./catalogs.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface OfflinePageOptions {
  readonly locale: Locale;
  readonly nonce: string;
  readonly message: string;
}

/** The board-offline response. The admin message is untrusted text and is escaped. */
export function offlinePage(options: OfflinePageOptions): Response {
  const t = createServerT(options.locale, { shipped: USER_CATALOGS });
  const message =
    options.message.trim() === "" ? t("board.offline.defaultMessage") : options.message;
  const title = t("board.offline.title");

  const html = `<!doctype html>
<html lang="${options.locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style nonce="${options.nonce}">
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f4f6f9;
        color: #1c2430;
      }
      main {
        width: min(100% - 2rem, 36rem);
        padding: 1.5rem;
        border: 1px solid #dce1e8;
        border-radius: 0.75rem;
        background: #ffffff;
      }
      h1 { margin: 0 0 0.75rem; font-size: 1.5rem; }
      p { margin: 0; color: #5c6878; white-space: pre-wrap; overflow-wrap: anywhere; }
      @media (prefers-color-scheme: dark) {
        body { background: #141a22; color: #e7ecf3; }
        main { background: #1d2530; border-color: #303b49; }
        p { color: #93a0b1; }
      }
    </style>
  </head>
  <body>
    <main data-offline>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;

  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
