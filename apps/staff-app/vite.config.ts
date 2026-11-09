import type { IncomingMessage, ServerResponse } from "node:http";
import { createDrainController } from "@bulletin/config/drain";
import { createCspNonce, securityHeaders } from "@bulletin/config/security";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const staffApiUrl = process.env.STAFF_API_INTERNAL_URL ?? "http://staff-api:3002";
const authIssuer =
  process.env.BULLETIN_AUTH_ISSUER ??
  `http://auth.bulletin.localhost:${process.env.BULLETIN_HTTP_PORT ?? "8080"}`;
const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development";
const cspNonce = createCspNonce();

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

function cspPlugin(): Plugin {
  const headers = securityHeaders({
    nonce: cspNonce,
    nodeEnv,
    connectSrc: [authIssuer],
  });
  const applyHeaders = (
    _request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): void => {
    for (const [name, value] of headers) {
      response.setHeader(name, value);
    }
    next();
  };

  return {
    name: "bulletin-csp",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(/<(script|style)(?![^>]*\bnonce=)/gi, `<$1 nonce="${cspNonce}"`);
      },
    },
    configureServer(server) {
      server.middlewares.use(applyHeaders);
    },
    configurePreviewServer(server) {
      server.middlewares.use(applyHeaders);
    },
  };
}

function healthPlugin(): Plugin {
  const drain = createDrainController();

  const tracker = (_request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const finish = drain.track();
    response.once("finish", finish);
    response.once("close", finish);
    next();
  };

  const handler = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const path = request.url?.split("?")[0];

    if (path === "/health/live") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", service: "staff-app" }));
      return;
    }

    if (path === "/health/ready") {
      if (drain.draining) {
        response.statusCode = 503;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "draining", checks: {} }));
        return;
      }

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
      server.middlewares.use(tracker);
      server.middlewares.use(handler);

      process.once("SIGTERM", () => {
        void drain
          .drain(Number(process.env.BULLETIN_DRAIN_TIMEOUT_MS ?? 25_000))
          .finally(() => process.exit(0));
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(tracker);
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), cspPlugin(), healthPlugin()],
});
