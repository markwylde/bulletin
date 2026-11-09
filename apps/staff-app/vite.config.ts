import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function healthPlugin(): Plugin {
  const handler = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const path = request.url?.split("?")[0];

    if (path === "/health/live" || path === "/health/ready") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", service: "staff-app" }));
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
