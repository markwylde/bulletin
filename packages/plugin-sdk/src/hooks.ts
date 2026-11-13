/** Hook and extension contracts shared by plugin authors, plugin-host and the core APIs. */

export interface ViewerContext {
  readonly memberId: string | null;
  readonly sessionId?: string | null;
}

export interface EnricherInput {
  readonly hook: string;
  readonly route: string;
  /** Fields the route already exposes; plugins treat this as read-only input. */
  readonly view: Readonly<Record<string, unknown>>;
  readonly viewer: ViewerContext;
}

export interface EnricherResult {
  readonly fields: Readonly<Record<string, unknown>>;
  /** Plugin-namespaced tags the fragment depends on. */
  readonly tags?: readonly string[];
}

export interface WriteContext {
  readonly authorId: string;
  readonly forumId?: string;
  readonly topicId?: string;
  readonly postId?: string;
}

export interface FilterInput {
  readonly hook: string;
  readonly content: string;
  readonly context: WriteContext;
  readonly viewer: ViewerContext;
}

export interface VetInput extends FilterInput {}

export interface VetoResult {
  readonly allow: boolean;
  /** i18n key the core translates into the rejection message. */
  readonly reasonKey?: string;
}

export interface EventDelivery {
  readonly type: string;
  readonly eventId: string;
  /** IDs only, never content or personal data (ADR 0011). */
  readonly payloadIds: Readonly<Record<string, string>>;
}

export interface JobDelivery {
  readonly name: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ContentExtensionInput {
  readonly syntax: string;
  readonly source: string;
  readonly viewer: ViewerContext;
}

export interface ContentExtensionResult {
  readonly html: string;
}

export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly viewer: ViewerContext;
}

export interface RouteResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface GdprSubject {
  readonly memberId: string;
}

export interface GdprExport {
  readonly data: Readonly<Record<string, unknown>>;
}

export type EnricherHandler = (input: EnricherInput) => Promise<EnricherResult> | EnricherResult;
export type FilterHandler = (input: FilterInput) => Promise<string> | string;
export type VetoHandler = (input: VetInput) => Promise<VetoResult> | VetoResult;
export type EventHandler = (event: EventDelivery) => Promise<void> | void;
export type JobHandler = (job: JobDelivery) => Promise<void> | void;
export type ContentExtensionHandler = (
  input: ContentExtensionInput,
) => Promise<ContentExtensionResult> | ContentExtensionResult;
export type RouteHandler = (request: RouteRequest) => Promise<RouteResponse> | RouteResponse;
export type GdprExportHandler = (subject: GdprSubject) => Promise<GdprExport> | GdprExport;
export type GdprEraseHandler = (subject: GdprSubject) => Promise<void> | void;

export interface EnricherDefinition {
  readonly fields: readonly string[];
  readonly deps?: readonly string[];
  readonly handler: EnricherHandler;
}

export interface FilterDefinition {
  readonly priority?: number;
  readonly handler: FilterHandler;
}

export interface VetoDefinition {
  readonly priority?: number;
  readonly reasonKey: string;
  readonly failMode?: "open" | "closed";
  readonly handler: VetoHandler;
}

export interface ClientAppDefinition {
  readonly name: string;
  readonly entry: string;
  readonly hooks: readonly string[];
}

export interface PluginDefinition {
  readonly id: string;
  readonly version?: string;
  readonly hooks: {
    readonly enrichers?: Readonly<Record<string, EnricherDefinition>>;
    readonly filters?: Readonly<Record<string, FilterDefinition>>;
    readonly vetoes?: Readonly<Record<string, VetoDefinition>>;
  };
  readonly events?: Readonly<Record<string, EventHandler>>;
  readonly jobs?: Readonly<Record<string, JobHandler>>;
  readonly contentExtensions?: Readonly<Record<string, ContentExtensionHandler>>;
  readonly routes?: Readonly<Record<string, RouteHandler>>;
  readonly gdpr?: {
    readonly export?: GdprExportHandler;
    readonly erase?: GdprEraseHandler;
  };
  readonly clientApps?: readonly ClientAppDefinition[];
  readonly i18n?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const HOOK_NAME = /^[a-z][a-z0-9_.-]{0,80}$/;

function assertHookNames(names: Iterable<string>, kind: string): void {
  for (const name of names) {
    if (!HOOK_NAME.test(name)) {
      throw new TypeError(`${kind} hook name is invalid: ${name}`);
    }
  }
}

/** Declares a plugin. Validation happens here, at build time, as well as at install time. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(definition.id)) {
    throw new TypeError(`Invalid plugin id: ${definition.id}`);
  }

  assertHookNames(Object.keys(definition.hooks.enrichers ?? {}), "enricher");
  assertHookNames(Object.keys(definition.hooks.filters ?? {}), "filter");
  assertHookNames(Object.keys(definition.hooks.vetoes ?? {}), "veto");

  for (const [name, veto] of Object.entries(definition.hooks.vetoes ?? {})) {
    if (veto.reasonKey === "") {
      throw new TypeError(`Veto ${name} must declare a reasonKey`);
    }
  }

  return definition;
}

/**
 * Resolves a plugin hook name against the SDK major it was built for. v1 used different
 * names; the host applies this shim before dispatch (ADR 0009, one-major compatibility).
 */
export function resolveHookName(
  name: string,
  shimMajor: number | null,
  shim: (name: string, major: number) => string,
): string {
  return shimMajor === null ? name : shim(name, shimMajor);
}
