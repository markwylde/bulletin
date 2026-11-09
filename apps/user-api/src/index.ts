const port = Number(Bun.env.PORT ?? 3001);

Bun.serve({
  port,
  fetch() {
    return Response.json({ service: "user-api", status: "ok" });
  },
});

console.log(`user-api listening on http://localhost:${port}`);
