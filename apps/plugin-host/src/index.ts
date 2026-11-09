import { startService } from "@bulletin/config/server";

const port = Number(Bun.env.PORT ?? 3004);

await startService({
  service: "plugin-host",
  port,
  fetch() {
    return Response.json({ service: "plugin-host", status: "ok" });
  },
  checks: [],
});

console.log(`plugin-host listening on http://localhost:${port}`);
