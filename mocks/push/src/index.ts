import { createPushHandler, createPushStore } from "./app.ts";

const port = Number(Bun.env.PORT ?? 4003);
const store = createPushStore();

Bun.serve({ port, fetch: createPushHandler(store) });

console.log(`mock-push listening on http://localhost:${port}`);
