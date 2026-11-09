const port = Number(Bun.env.PORT ?? 3003);

Bun.serve({
  port,
  fetch() {
    return Response.json({ service: "workers", status: "ok" });
  },
});

console.log(`workers listening on http://localhost:${port}`);
