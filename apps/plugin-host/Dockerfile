# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine AS deps

# nsjail is the plugin sandbox (ADR 0009). The container runs it with CAP_SYS_ADMIN and an
# unconfined outer seccomp profile; the jail applies its own default-deny filter.
RUN apk add --no-cache nsjail

# Minimal read-only root filesystem the jail chroots into: Bun, its musl loader, and the
# device nodes the runtime needs. Everything else comes from bind mounts at spawn time.
RUN mkdir -p /opt/plugin-rootfs/bin /opt/plugin-rootfs/lib /opt/plugin-rootfs/usr/lib \
      /opt/plugin-rootfs/dev /opt/plugin-rootfs/run /opt/plugin-rootfs/tmp \
 && cp /usr/local/bin/bun /opt/plugin-rootfs/bin/bun \
 && cp -L /lib/ld-musl-*.so.1 /opt/plugin-rootfs/lib/ \
 && cp /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /opt/plugin-rootfs/usr/lib/ \
 && touch /opt/plugin-rootfs/dev/null /opt/plugin-rootfs/dev/zero \
      /opt/plugin-rootfs/dev/urandom /opt/plugin-rootfs/run/broker.sock

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile \
 && chmod -R a+rX /app/apps/plugin-host/src/spike/plugin

FROM deps AS dev

WORKDIR /app
EXPOSE 3004
CMD ["bun", "--watch", "apps/plugin-host/src/index.ts"]

FROM deps AS production

WORKDIR /app
ENV NODE_ENV=production
CMD ["bun", "apps/plugin-host/src/index.ts"]
