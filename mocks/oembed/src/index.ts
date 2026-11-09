import { createOembedHandler } from "./app.ts";

const port = Number(Bun.env.PORT ?? 4005);
const handler = createOembedHandler();

Bun.serve({ port, fetch: handler });

console.log(`mock-oembed listening on http://localhost:${port}`);
