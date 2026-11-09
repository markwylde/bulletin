# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine AS deps

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

FROM deps AS dev

ARG MOCK_NAME
ENV MOCK_NAME=${MOCK_NAME}
CMD ["sh", "-c", "exec bun --watch \"mocks/$MOCK_NAME/src/index.ts\""]

FROM deps AS production

ARG MOCK_NAME
ENV MOCK_NAME=${MOCK_NAME}
CMD ["sh", "-c", "exec bun \"mocks/$MOCK_NAME/src/index.ts\""]
