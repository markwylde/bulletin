const port = Number(Bun.env.PORT ?? 3004);

Bun.serve({
  port,
  fetch() {
    return Response.json({ service: "plugin-host", status: "ok" });
  },
});

console.log(`plugin-host listening on http://localhost:${port}`);
