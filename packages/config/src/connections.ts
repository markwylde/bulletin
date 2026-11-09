export const SERVICE_NAMES = [
  "user-app",
  "user-api",
  "staff-api",
  "workers",
  "plugin-host",
] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];

export interface ConnectionShare {
  readonly pool: number;
  readonly listener: number;
  readonly queue: number;
}

/** Defaults from ADR 0020, per replica. */
export const DEFAULT_CONNECTIONS: Readonly<Record<ServiceName, ConnectionShare>> = {
  "user-app": { pool: 10, listener: 1, queue: 0 },
  "user-api": { pool: 10, listener: 1, queue: 0 },
  "staff-api": { pool: 5, listener: 1, queue: 0 },
  workers: { pool: 5, listener: 1, queue: 10 },
  "plugin-host": { pool: 20, listener: 0, queue: 2 },
};

export const DEFAULT_REPLICAS: Readonly<Record<ServiceName, number>> = {
  "user-app": 1,
  "user-api": 1,
  "staff-api": 1,
  workers: 1,
  "plugin-host": 1,
};

export interface ConnectionBudgetOptions {
  readonly maxConnections: number;
  readonly reserve?: number;
  readonly connections?: Partial<Record<ServiceName, ConnectionShare>>;
  readonly replicas?: Partial<Record<ServiceName, number>>;
}

export interface ConnectionBudgetShare {
  readonly service: ServiceName;
  readonly perReplica: number;
  readonly replicas: number;
  readonly total: number;
}

export interface ConnectionBudgetResult {
  readonly ok: boolean;
  readonly maxConnections: number;
  readonly reserve: number;
  readonly available: number;
  readonly required: number;
  readonly shares: readonly ConnectionBudgetShare[];
}

export class ConnectionBudgetError extends Error {
  readonly result: ConnectionBudgetResult;

  constructor(result: ConnectionBudgetResult) {
    const details = result.shares
      .map((share) => `${share.service} ${share.perReplica}×${share.replicas}=${share.total}`)
      .join(", ");

    super(
      `Connection budget exceeded: need ${result.required}, available ${result.available} ` +
        `(max_connections=${result.maxConnections}, reserve=${result.reserve}). ${details}`,
    );
    this.name = "ConnectionBudgetError";
    this.result = result;
  }
}

function replicaCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

export function resolveConnectionShare(
  service: ServiceName,
  connections?: Partial<Record<ServiceName, ConnectionShare>>,
): ConnectionShare {
  return {
    ...DEFAULT_CONNECTIONS[service],
    ...(connections?.[service] ?? {}),
  };
}

export function connectionPoolSize(
  service: ServiceName,
  connections?: Partial<Record<ServiceName, ConnectionShare>>,
): number {
  return resolveConnectionShare(service, connections).pool;
}

/** Pure connection-budget calculation across every declared service replica. */
export function checkConnectionBudget(options: ConnectionBudgetOptions): ConnectionBudgetResult {
  const reserve = options.reserve ?? 10;
  const available = Math.max(0, options.maxConnections - reserve);
  const shares: ConnectionBudgetShare[] = [];

  for (const service of SERVICE_NAMES) {
    const connection = resolveConnectionShare(service, options.connections);
    const replicas = replicaCount(options.replicas?.[service] ?? DEFAULT_REPLICAS[service]);
    const perReplica = connection.pool + connection.listener + connection.queue;

    shares.push({ service, perReplica, replicas, total: perReplica * replicas });
  }

  const required = shares.reduce((sum, share) => sum + share.total, 0);

  return {
    ok: required <= available,
    maxConnections: options.maxConnections,
    reserve,
    available,
    required,
    shares,
  };
}

export function assertConnectionBudget(options: ConnectionBudgetOptions): ConnectionBudgetResult {
  const result = checkConnectionBudget(options);

  if (!result.ok) {
    throw new ConnectionBudgetError(result);
  }

  return result;
}

/** Parses `user-api=2,workers=3`; used by deployments to declare replica counts. */
export function parseReplicas(value: string | undefined): Partial<Record<ServiceName, number>> {
  if (value === undefined || value.trim() === "") {
    return {};
  }

  const replicas: Partial<Record<ServiceName, number>> = {};

  for (const entry of value.split(",")) {
    const [name, rawCount] = entry.trim().split("=");
    const service = SERVICE_NAMES.find((candidate) => candidate === name);
    const count = Number(rawCount);

    if (service !== undefined && Number.isFinite(count) && count > 0) {
      replicas[service] = Math.floor(count);
    }
  }

  return replicas;
}
