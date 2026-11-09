import { createCdn } from "./app.ts";

const port = Number(Bun.env.PORT ?? 4006);
const cdn = createCdn({
  origin: Bun.env.CDN_ORIGIN ?? "http://user-app:4321",
  upstreamHost: Bun.env.CDN_UPSTREAM_HOST ?? "bulletin.localhost",
});

Bun.serve({ port, fetch: cdn.handler });

console.log(
  `mock-cdn listening on http://localhost:${port}, origin ${Bun.env.CDN_ORIGIN ?? "http://user-app:4321"}`,
);
