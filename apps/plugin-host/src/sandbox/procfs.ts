import type { SandboxCgroupUsage } from "./types.ts";

const PROC_ROOT = "/proc";
const CGROUP_PREFIX = "NSJAIL.";

/** Reads a virtual file, returning `undefined` when it does not exist or is unreadable. */
export async function readProcFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch {
    return undefined;
  }
}

/** PIDs of a process's direct children, as seen in the plugin-host's PID namespace. */
export async function readChildPids(pid: number): Promise<number[]> {
  const text = await readProcFile(`${PROC_ROOT}/${pid}/task/${pid}/children`);

  if (text === undefined) {
    return [];
  }

  return text
    .trim()
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

/** Waits briefly for nsjail to clone the jailed process. */
export async function findChildPid(pid: number, timeoutMs = 2_000): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const child = (await readChildPids(pid))[0];

    if (child !== undefined) {
      return child;
    }

    await Bun.sleep(10);
  }

  return undefined;
}

/** Resident set size of one process, in bytes. */
export async function readRssBytes(pid: number): Promise<number | undefined> {
  const status = await readProcFile(`${PROC_ROOT}/${pid}/status`);
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status ?? "");

  return match?.[1] === undefined ? undefined : Number(match[1]) * 1024;
}

/** Resident set size of a process and all of its descendants, in bytes. */
export async function readProcessTreeRssBytes(pid: number, depth = 0): Promise<number> {
  if (depth > 8) {
    return 0;
  }

  const own = (await readRssBytes(pid)) ?? 0;
  const children = await readChildPids(pid);
  const descendants = await Promise.all(
    children.map((child) => readProcessTreeRssBytes(child, depth + 1)),
  );

  return own + descendants.reduce((total, value) => total + value, 0);
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) {
    return null;
  }

  return Number(value.trim());
}

/**
 * Reads the sandbox's own cgroup. nsjail names it `NSJAIL.<pid>` under the configured cgroup
 * v2 mount, using the PID visible in the plugin-host's namespace.
 */
export async function readSandboxCgroup(
  cgroupV2Mount: string,
  childPid: number,
): Promise<SandboxCgroupUsage | undefined> {
  const directory = `${cgroupV2Mount.replace(/\/+$/, "")}/${CGROUP_PREFIX}${childPid}`;
  const memoryCurrent = await readProcFile(`${directory}/memory.current`);

  if (memoryCurrent === undefined) {
    return undefined;
  }

  const [memoryMax, memoryStat, pidsMax, cpuMax] = await Promise.all([
    readProcFile(`${directory}/memory.max`),
    readProcFile(`${directory}/memory.stat`),
    readProcFile(`${directory}/pids.max`),
    readProcFile(`${directory}/cpu.max`),
  ]);
  const stat = parseMemoryStat(memoryStat);

  return {
    memoryCurrentBytes: parseCount(memoryCurrent),
    memoryMaxBytes: parseCount(memoryMax),
    anonBytes: stat.anon,
    fileBytes: stat.file,
    pidsMax: parseCount(pidsMax),
    cpuMax: cpuMax?.trim() ?? null,
  };
}

function parseMemoryStat(text: string | undefined): {
  anon: number | null;
  file: number | null;
} {
  const values = new Map<string, number>();

  for (const line of (text ?? "").split("\n")) {
    const [name, value] = line.trim().split(/\s+/);

    if (name !== undefined && value !== undefined && /^\d+$/.test(value)) {
      values.set(name, Number(value));
    }
  }

  return { anon: values.get("anon") ?? null, file: values.get("file") ?? null };
}
