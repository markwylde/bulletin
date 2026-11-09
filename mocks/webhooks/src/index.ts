import { createWebhookHandler, createWebhookStore } from "./app.ts";

const port = Number(Bun.env.PORT ?? 4004);
const store = createWebhookStore();
const secret = Bun.env.WEBHOOK_SECRET ?? "bulletin-dev-webhook-secret";

Bun.serve({ port, fetch: createWebhookHandler(store, secret) });

console.log(`mock-webhooks listening on http://localhost:${port}`);
