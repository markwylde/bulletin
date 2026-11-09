const port = Number(Bun.env.PORT ?? 3002);

Bun.serve({
  port,
  fetch() {
    return Response.json({ service: "staff-api", status: "ok" });
  },
});

console.log(`staff-api listening on http://localhost:${port}`);
