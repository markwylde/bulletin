# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine AS deps

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

FROM deps AS dev

WORKDIR /app/apps/staff-app
EXPOSE 5173
CMD ["bun", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

FROM deps AS production

WORKDIR /app/apps/staff-app
ENV NODE_ENV=production
RUN bun run build
EXPOSE 5173
CMD ["bun", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
