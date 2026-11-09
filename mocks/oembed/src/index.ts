import { createOembedHandler } from "./app.ts";

const port = Number(Bun.env.PORT ?? 4005);
const providerUrl =
  Bun.env.BULLETIN_PUBLIC_ORIGIN ??
  `http://bulletin.localhost:${Bun.env.BULLETIN_HTTP_PORT ?? "8080"}`;
const handler = createOembedHandler({ providerUrl });

Bun.serve({ port, fetch: handler });

console.log(`mock-oembed listening on http://localhost:${port}`);
