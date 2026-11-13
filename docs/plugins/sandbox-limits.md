# Sandbox limits

Server code runs under nsjail, one sandbox per plugin, with:

- its own UID and user namespace, a read-only bundle mount, private `/tmp` and an empty
  `/proc`;
- a new empty network namespace — the broker Unix socket is the only channel;
- no environment secrets (only `PLUGIN_ID`, `PLUGIN_SOCKET`, `HOME`, `TMPDIR` and the Bun
  transpiler-cache switch);
- cgroup v2 limits: 256 MiB memory, 64 pids, 500 ms CPU per second, plus rlimits and a
  wall-clock watchdog;
- a default-deny Kafel seccomp profile (no ptrace, mount, namespace, keyring, BPF, io_uring,
  module, file/admin or credential syscalls).

Database work is bounded by the broker: DML only in the plugin schema, two concurrent
statements, 20 statements/second, `statement_timeout = 2s`, `work_mem = 8MB`,
`temp_file_limit = 64MB`, a 1 GB schema quota (writes revoked when exceeded), and statement
cancellation from a control connection. Migrations run as `plugin_migrator` in one transaction
with the AST rules from ADR 0009.

Client code runs only in an iframe on the plugin origin with
`sandbox="allow-scripts allow-forms"` (no `allow-same-origin`), so it has no forum cookies or
ambient credentials. It talks through a per-iframe `MessageChannel` with a random instance
token; the host ignores `window` messages.
