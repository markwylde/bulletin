/**
 * Malicious probe used only by `malicious.test.ts`. The supervisor executes one case as
 * `/bin/bun /plugin/server.ts <case>`; results are reported to the broker over the normal
 * JSON-RPC channel.
 */
import { connectBroker } from "./rpc.ts";

const caseName = process.argv[2] ?? "";
const pluginId = process.env.PLUGIN_ID;
const socketPath = process.env.PLUGIN_SOCKET;

if (pluginId === undefined || socketPath === undefined) {
  throw new Error("PLUGIN_ID and PLUGIN_SOCKET are required");
}

interface Result {
  readonly ok: boolean;
  readonly detail: string;
  readonly [key: string]: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const client = await connectBroker(socketPath, { pluginId, sdkVersion: "0.0.0" });

async function denial(sql: string): Promise<{
  readonly denied: boolean;
  readonly message: string;
  readonly recovered: boolean;
}> {
  let denied = false;
  let message = "";

  try {
    await client.call("db.query", { sql });
  } catch (error) {
    denied = true;
    message = errorMessage(error);
  }

  let recovered = false;

  try {
    const result = await client.call<{ rows: unknown[] }>("db.query", {
      sql: "SELECT 1 AS ok",
    });
    recovered = result.rows.length === 1;
  } catch {
    recovered = false;
  }

  return { denied, message, recovered };
}

async function runCase(): Promise<Result> {
  switch (caseName) {
    case "read-core": {
      const result = await denial("SELECT * FROM core.cache_tags");
      return {
        ok: result.denied && result.recovered,
        detail: result.message,
        recovered: result.recovered,
      };
    }

    case "read-pii": {
      const result = await denial("SELECT * FROM pii.sessions");
      return {
        ok: result.denied && result.recovered,
        detail: result.message,
        recovered: result.recovered,
      };
    }

    case "runtime-ddl": {
      const result = await denial("CREATE TABLE evil (id int)");
      return {
        ok: result.denied && result.recovered,
        detail: result.message,
        recovered: result.recovered,
      };
    }

    case "large-result": {
      let denied = "";

      try {
        await client.call("db.query", {
          sql: "SELECT repeat('x', 4194304) AS body",
        });
      } catch (error) {
        denied = errorMessage(error);
      }

      let recovered = false;

      try {
        const result = await client.call<{ rows: unknown[] }>("db.query", {
          sql: "SELECT 1 AS ok",
        });
        recovered = result.rows.length === 1;
      } catch {
        recovered = false;
      }

      return { ok: denied !== "" && recovered, detail: denied, recovered };
    }

    case "listen": {
      const result = await denial("LISTEN malicious");
      return {
        ok: result.denied && result.recovered,
        detail: result.message,
        recovered: result.recovered,
      };
    }

    case "tcp-socket": {
      const port = Number(process.argv[3]);

      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        return { ok: false, detail: "missing listener port" };
      }

      let error = "";

      try {
        await Promise.race([
          Bun.connect({
            hostname: "127.0.0.1",
            port,
            socket: { data() {}, error() {} },
          }).then(() => {
            throw new Error("connected");
          }),
          Bun.sleep(1_000).then(() => {
            throw new Error("timed out");
          }),
        ]);
        error = "connected";
      } catch (caught) {
        error = errorMessage(caught);
      }

      return { ok: error !== "connected", detail: error };
    }

    case "sibling-bundle": {
      const current = await Bun.file("/plugin/server.ts").exists();
      const candidates = [
        "/plugin/../demo/plugin/server.ts",
        "/app/apps/plugin-host/src/demo/plugin/server.ts",
        "/tmp/malicious-sibling/secret",
      ];
      const visible: string[] = [];

      for (const path of candidates) {
        if (await Bun.file(path).exists()) {
          visible.push(path);
        }
      }

      return {
        ok: current && visible.length === 0,
        detail: visible.length === 0 ? "no sibling visible" : visible.join(","),
        currentBundleVisible: current,
      };
    }

    case "environment": {
      const keys = Object.keys(process.env).sort();
      const secrets = keys.filter((key) =>
        /DATABASE|SESSION|SECRET|TOKEN|PASSWORD|PGPASSWORD/i.test(key),
      );

      return {
        ok: secrets.length === 0 && keys.includes("PLUGIN_ID") && keys.includes("PLUGIN_SOCKET"),
        detail: secrets.length === 0 ? "no secrets" : `secret keys: ${secrets.join(",")}`,
        keys,
      };
    }

    case "proc": {
      let entries: string[] = [];

      try {
        const { readdir } = await import("node:fs/promises");
        entries = await readdir("/proc");
      } catch {
        entries = [];
      }

      const statusVisible = await Bun.file("/proc/self/status").exists();

      return {
        ok: entries.length === 0 && !statusVisible,
        detail: `entries=${entries.length} status=${String(statusVisible)}`,
      };
    }

    case "fork-bomb": {
      // Run the loop in a child so the parent can still report; the child shares the
      // sandbox's cgroup and pids limit.
      const bomberCode =
        'const kids = []; for (let i = 0; i < 200; i += 1) { try { kids.push(Bun.spawn(["/bin/bun", "-e", "await new Promise(() => {})"], { stdout: "ignore", stderr: "ignore" })); } catch { break; } } await new Promise(() => {});';
      const bomber = Bun.spawn(["/bin/bun", "-e", bomberCode], {
        stdout: "ignore",
        stderr: "ignore",
      });

      await Bun.sleep(750);
      return { ok: true, detail: "fork loop running", spawned: 1, bomberPid: bomber.pid };
    }

    case "output-flood": {
      const chunk = "x".repeat(1024 * 1024);

      for (let index = 0; index < 8; index += 1) {
        process.stdout.write(chunk);
      }

      for (let index = 0; index < 2_000; index += 1) {
        process.stdout.write(`stdout flood ${index}\n`);
      }

      for (let index = 0; index < 8; index += 1) {
        process.stderr.write(chunk);
      }

      for (let index = 0; index < 2_000; index += 1) {
        process.stderr.write(`stderr flood ${index}\n`);
      }

      await Bun.sleep(100);
      return { ok: true, detail: "flood sent" };
    }

    case "memory-exhaustion": {
      const chunks: Uint8Array[] = [];

      try {
        for (;;) {
          chunks.push(new Uint8Array(16 * 1024 * 1024).fill(1));
          await Bun.sleep(10);
        }
      } catch (error) {
        return { ok: false, detail: errorMessage(error) };
      }
    }

    default:
      return { ok: false, detail: `unknown case: ${caseName}` };
  }
}

async function report(result: Result): Promise<void> {
  try {
    await client.call("log", {
      level: "info",
      message: "malicious-case",
      fields: { case: caseName, phase: "result", ...result },
    });
  } catch (error) {
    console.error(`could not report ${caseName}: ${errorMessage(error)}`);
  }
}

async function reportStarted(): Promise<void> {
  await client.call("log", {
    level: "info",
    message: "malicious-case",
    fields: { case: caseName, phase: "start" },
  });
}

try {
  await reportStarted();
  await report(await runCase());
} catch (error) {
  await report({ ok: false, detail: errorMessage(error) });
}

// Keep the process alive unless the sandbox kills it (fork/memory cases).
await new Promise(() => {});
