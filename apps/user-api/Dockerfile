# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine AS deps

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

FROM deps AS dev

WORKDIR /app
EXPOSE 3001
CMD ["bun", "--watch", "apps/user-api/src/index.ts"]

FROM deps AS production

WORKDIR /app
ENV NODE_ENV=production
CMD ["bun", "apps/user-api/src/index.ts"]
