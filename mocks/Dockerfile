# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine AS deps

WORKDIR /app
COPY . .
RUN --mount=type=cache,id=bulletin-bun-cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile

FROM deps AS dev

ARG MOCK_NAME
ENV MOCK_NAME=${MOCK_NAME}
# Reference the argument in a layer so each mock gets a distinct image (and cache entry).
RUN test -d "mocks/${MOCK_NAME}"
CMD ["sh", "-c", "exec bun --watch \"mocks/$MOCK_NAME/src/index.ts\""]

FROM deps AS production

ARG MOCK_NAME
ENV MOCK_NAME=${MOCK_NAME}
RUN test -d "mocks/${MOCK_NAME}"
CMD ["sh", "-c", "exec bun \"mocks/$MOCK_NAME/src/index.ts\""]
