# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine AS deps

WORKDIR /app
COPY . .
RUN --mount=type=cache,id=bulletin-bun-cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile

FROM deps AS dev

WORKDIR /app/apps/user-app
EXPOSE 4321
CMD ["bun", "run", "dev", "--", "--host", "0.0.0.0", "--port", "4321"]

FROM deps AS production

WORKDIR /app/apps/user-app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
RUN bun run build
EXPOSE 4321
CMD ["bun", "./dist/server/entry.mjs"]
