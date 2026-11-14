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

# Trace one real sandbox launch (nsjail + plugin) and report what seccomp killed.
cd /app/apps/plugin-host
PLUGIN_HOST_MEASURE_ITERATIONS=1 timeout 60 strace -f -qq -o /tmp/sandbox-trace.txt \
  bun src/demo/measure.ts >/tmp/measure.out 2>&1
echo "--- measure output ---"
tail -15 /tmp/measure.out
echo "--- killed / exited processes ---"
grep -E "\+\+\+ (killed|exited)|si_code=SYS_SECCOMP" /tmp/sandbox-trace.txt | head -20
echo "--- last calls of each killed process ---"
for pid in $(grep -E "\+\+\+ killed" /tmp/sandbox-trace.txt | awk '{print $1}' | head -3); do
  echo "pid $pid:"; grep -E "^$pid " /tmp/sandbox-trace.txt | tail -8
done
echo "--- jailed process: failed calls and last activity ---"
jail=$(grep -E "prctl\(PR_SET_SECCOMP" /tmp/sandbox-trace.txt | head -1 | awk '{print $1}')
if [ -n "$jail" ]; then
  # Threads of the jailed process are its children in the trace; show every failing call.
  grep -E " = -1 E" /tmp/sandbox-trace.txt | awk -v p="$jail" '$1 >= p' | grep -v "EAGAIN\|ETIMEDOUT" | cut -c1-250 | head -40
  echo "--- tail ---"
  awk -v p="$jail" '$1 >= p' /tmp/sandbox-trace.txt | tail -40 | cut -c1-250
fi
echo "--- execve calls ---"
grep -E "execve\(" /tmp/sandbox-trace.txt | cut -c1-300 | head -10
