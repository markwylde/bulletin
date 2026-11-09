import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const staffApiUrl = process.env.STAFF_API_INTERNAL_URL ?? "http://staff-api:3002";

async function readiness(): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(`${staffApiUrl}/health/ready`);
    const body: unknown = await response.json().catch(() => ({
      status: response.ok ? "ok" : "unavailable",
    }));

    return { status: response.ok ? 200 : 503, body };
  } catch {
    return { status: 503, body: { status: "unavailable", checks: { staffApi: false } } };
  }
}

function healthPlugin(): Plugin {
  const handler = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const path = request.url?.split("?")[0];

    if (path === "/health/live") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", service: "staff-app" }));
      return;
    }

    if (path === "/health/ready") {
      void readiness().then(({ status, body }) => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      });
      return;
    }

    next();
  };

  return {
    name: "bulletin-health",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), healthPlugin()],
});
