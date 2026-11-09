import { escapeHtml, htmlResponse, jsonResponse, renderPage } from "@bulletin/mock-ui";

const THUMBNAIL = "/_mocks/oembed/thumb.svg";

function target(url: URL): string | null {
  const value = url.searchParams.get("url");

  if (value === null) {
    return null;
  }

  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

export interface OembedHandlerOptions {
  /** Public forum origin; the default keeps the documented local stack (ADR 0002). */
  readonly providerUrl?: string;
}

export function createOembedHandler(
  options: OembedHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const providerUrl = options.providerUrl ?? "http://bulletin.localhost:8080";

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok" });
    }

    if (url.pathname === "/thumb.svg") {
      return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="#3557c7"/><text x="30" y="110" fill="white" font-size="32" font-family="sans-serif">Bulletin embed</text></svg>',
        { headers: { "content-type": "image/svg+xml" } },
      );
    }

    if (url.pathname === "/oembed") {
      const value = target(url);

      if (value === null) {
        return jsonResponse({ error: "A valid ?url= is required" }, 400);
      }

      const host = new URL(value).hostname;

      return jsonResponse({
        type: "rich",
        version: "1.0",
        title: `Mock embed for ${host}`,
        author_name: "Bulletin mock",
        provider_name: "Bulletin OEmbed",
        provider_url: providerUrl,
        thumbnail_url: THUMBNAIL,
        thumbnail_width: 600,
        thumbnail_height: 200,
        width: 600,
        height: 200,
        html: `<blockquote><p>${escapeHtml(value)}</p></blockquote>`,
      });
    }

    if (url.pathname === "/page") {
      const value = target(url);

      if (value === null) {
        return htmlResponse("<p>A valid ?url= is required.</p>", 400);
      }

      const host = new URL(value).hostname;

      return htmlResponse(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Mock link preview: ${escapeHtml(host)}</title>
    <meta property="og:title" content="Mock link preview for ${escapeHtml(host)}">
    <meta property="og:description" content="Canned OpenGraph description for ${escapeHtml(value)}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${escapeHtml(value)}">
    <meta property="og:image" content="${escapeHtml(THUMBNAIL)}">
    <link rel="alternate" type="application/json+oembed" href="/_mocks/oembed/oembed?url=${encodeURIComponent(value)}">
  </head>
  <body><article><h1>Mock link preview for ${escapeHtml(host)}</h1><p>${escapeHtml(value)}</p></article></body>
</html>`);
    }

    if (url.pathname !== "/" && url.pathname !== "") {
      return new Response("Not found", { status: 404 });
    }

    return htmlResponse(
      renderPage(
        "oEmbed mock",
        `<div class="panel">
          <p>Canned unfurl targets:</p>
          <ul>
            <li><a href="./oembed?url=https%3A%2F%2Fexample.test%2Farticle">oEmbed JSON</a></li>
            <li><a href="./page?url=https%3A%2F%2Fexample.test%2Farticle">OpenGraph HTML</a></li>
            <li><a href="./thumb.svg">Thumbnail</a></li>
          </ul>
        </div>`,
      ),
    );
  };
}
