#!/bin/sh
# Runs inside the plugin-host container (stdin) when CI fails. Lists the syscalls Bun makes
# on this architecture that the plugin seccomp profile does not allow.
set -u
apk add --no-cache strace >/dev/null 2>&1 || { echo "strace unavailable"; exit 0; }
cat > /tmp/probe.ts <<'TS'
import { connect } from "node:net";
import { readFileSync } from "node:fs";
readFileSync("/etc/hostname");
const socket = connect("/tmp/no-such.sock");
socket.on("error", () => {});
await new Promise((resolve) => setTimeout(resolve, 100));
await fetch("http://127.0.0.1:1/").catch(() => {});
TS
strace -f -qq -o /tmp/trace.txt bun /tmp/probe.ts >/dev/null 2>&1
sed -E 's/^[0-9]+ +//; s/\(.*//' /tmp/trace.txt | grep -E '^[a-z_0-9]+$' | sort -u > /tmp/used.txt
cd /app/apps/plugin-host && bun -e '
  const { buildSeccompPolicy, sandboxArch } = await import("./src/sandbox/seccomp.ts");
  const policy = buildSeccompPolicy(sandboxArch(process.arch));
  const used = (await Bun.file("/tmp/used.txt").text()).trim().split("\n");
  const missing = used.filter((name) => !new RegExp(`\\b(SYS_)?${name}\\b`).test(policy));
  console.log(`arch=${process.arch} used=${used.length} not-in-policy: ${missing.join(" ") || "(none)"}`);
'
