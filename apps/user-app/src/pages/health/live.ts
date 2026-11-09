export function GET(): Response {
  return Response.json({ status: "ok", service: "user-app" });
}
