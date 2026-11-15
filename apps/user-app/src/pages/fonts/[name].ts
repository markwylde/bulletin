import type { APIRoute } from "astro";
import { FONT_CACHE_CONTROL, interFilePath } from "../../fonts/inter.ts";

/** `GET /fonts/<name>`: the self-hosted Inter files (ADR 0021). Same for every viewer. */
export const GET: APIRoute = async ({ params }) => {
  const path = interFilePath(params.name ?? "");

  if (path === null) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(path);

  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(file, {
    headers: {
      "content-type": path.endsWith(".txt") ? "text/plain; charset=utf-8" : "font/woff2",
      "cache-control": FONT_CACHE_CONTROL,
      "access-control-allow-origin": "*",
    },
  });
};
