const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; --bg: #f5f6f8; --panel: #fff; --text: #1c2430; --muted: #5c6878; --line: #dce1e8; --accent: #3557c7; }
      @media (prefers-color-scheme: dark) { :root { --bg: #141a22; --panel: #1d2530; --text: #e7ecf3; --muted: #93a0b1; --line: #303b49; --accent: #9db0ff; } }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
      main { width: min(100% - 2rem, 60rem); margin: 0 auto; padding: 1.5rem 0 3rem; }
      h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
      p.lede { color: var(--muted); margin: 0 0 1.5rem; }
      .panel { background: var(--panel); border: 1px solid var(--line); border-radius: .75rem; padding: 1rem; overflow-x: auto; }
      table { border-collapse: collapse; width: 100%; font-size: .9rem; }
      th, td { text-align: left; border-bottom: 1px solid var(--line); padding: .5rem .4rem; vertical-align: top; }
      th { color: var(--muted); font-weight: 600; }
      code, pre { font-family: ui-monospace, monospace; font-size: .85rem; }
      a { color: var(--accent); }
      .empty { color: var(--muted); }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p class="lede">Local development mock. Not part of production.</p>
      ${body}
    </main>
  </body>
</html>`;
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
