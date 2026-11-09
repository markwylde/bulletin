export const RESOURCE_KINDS = ["forum", "topic", "profile"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface ResourceRef {
  readonly kind: ResourceKind;
  readonly id: bigint;
  readonly slug: string | null;
  readonly page: number | null;
  readonly postId: bigint | null;
}

export type SlugStatus = "ok" | "missing" | "outdated";

export interface CanonicalUrlOptions {
  readonly page?: number;
  readonly postId?: bigint | number | string;
}

export interface ResolvedResourceUrl {
  readonly status: 200 | 301;
  readonly location: string | null;
}

const PATH_PATTERN =
  /^\/(forum|topic|profile)\/(\d+)(?:-([^/]*))?(?:\/page\/(\d+))?(?:\/post\/(\d+))?\/?$/;

/** Produces a stable, ASCII slug from a title. */
export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80)
    .replace(/-+$/g, "");

  return slug === "" ? "item" : slug;
}

function positiveBigInt(value: bigint | number | string): bigint | null {
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

export function canonicalUrl(
  kind: ResourceKind,
  id: bigint | number | string,
  slug: string,
  options: CanonicalUrlOptions = {},
): string {
  const identifier = positiveBigInt(id);

  if (identifier === null) {
    throw new RangeError(`Invalid ${kind} ID`);
  }

  const safeSlug = slugify(slug);
  let path = `/${kind}/${identifier}-${safeSlug}`;
  const postId = options.postId === undefined ? null : positiveBigInt(options.postId);

  if (postId !== null) {
    path += `/post/${postId}`;
  } else if (options.page !== undefined && Number.isInteger(options.page) && options.page > 1) {
    path += `/page/${options.page}`;
  }

  return path;
}

/** Parses the route shape; resolution is always by numeric ID, never by slug. */
export function parseResourcePath(pathname: string): ResourceRef | null {
  const match = PATH_PATTERN.exec(pathname);

  if (match === null) {
    return null;
  }

  const kind = match[1] as ResourceKind;
  const id = positiveBigInt(match[2] ?? "");
  const page = match[4] === undefined ? null : Number.parseInt(match[4], 10);
  const postId = match[5] === undefined ? null : positiveBigInt(match[5]);

  if (id === null || (match[5] !== undefined && postId === null)) {
    return null;
  }

  if (page !== null && (!Number.isInteger(page) || page < 1)) {
    return null;
  }

  if (kind !== "topic" && (page !== null || postId !== null)) {
    return null;
  }

  if (page !== null && postId !== null) {
    return null;
  }

  const slug = match[3] === undefined || match[3] === "" ? null : match[3];
  return { kind, id, slug, page, postId };
}

export function slugStatus(ref: ResourceRef, currentSlug: string): SlugStatus {
  if (ref.slug === null) {
    return "missing";
  }

  return ref.slug === slugify(currentSlug) ? "ok" : "outdated";
}

/** Missing and outdated slugs redirect (301) to the canonical ID-based URL. */
export function resolveResourceUrl(ref: ResourceRef, currentSlug: string): ResolvedResourceUrl {
  const status = slugStatus(ref, currentSlug);

  if (status === "ok") {
    return { status: 200, location: null };
  }

  return {
    status: 301,
    location: canonicalUrl(ref.kind, ref.id, currentSlug, {
      ...(ref.page === null ? {} : { page: ref.page }),
      ...(ref.postId === null ? {} : { postId: ref.postId }),
    }),
  };
}
