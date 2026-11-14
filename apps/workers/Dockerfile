# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine AS deps

WORKDIR /app
COPY . .
RUN --mount=type=cache,id=bulletin-bun-cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile

FROM deps AS dev

WORKDIR /app
EXPOSE 3003
CMD ["bun", "--watch", "apps/workers/src/index.ts"]

FROM deps AS production

WORKDIR /app
ENV NODE_ENV=production
CMD ["bun", "apps/workers/src/index.ts"]
