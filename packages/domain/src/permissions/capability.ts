import {
  type CapabilityBit,
  capabilityBitIndex,
  hasCapabilityBit,
  isModeratorPower,
} from "./actions.ts";
import type { ForumTree } from "./tree.ts";

/**
 * The per-request capability data the snapshot compiler produces (ADR 0005): a capability
 * bitmap per forum plus the password-forum unlocks carried by the current session.
 */
export interface CapabilitySnapshot {
  readonly tree: ForumTree;
  readonly bits: ReadonlyMap<string, number>;
  readonly unlocked: ReadonlySet<string>;
}

export interface CapabilityDep {
  readonly forumId: string;
  readonly bit: CapabilityBit;
}

export interface CapabilityViewOptions extends CapabilitySnapshot {
  /** The view-model name used in undeclared-bit errors. */
  readonly view?: string;
  /** Every bit this view may read (ADR 0005). Declaring deps enables tracking by default. */
  readonly deps?: readonly CapabilityDep[];
  readonly enforceDeps?: boolean;
}

export interface RecordedCapabilityRead {
  readonly forumId: string;
  readonly bit: CapabilityBit;
  readonly allowed: boolean;
  /** True when the answer came from the session unlock rather than the mask bitmap. */
  readonly unlockDependent: boolean;
  readonly unlocked: boolean;
}

interface Resolution {
  readonly allowed: boolean;
  readonly unlockDependent: boolean;
  readonly unlocked: boolean;
}

export class UndeclaredCapabilityError extends Error {
  readonly view: string;
  readonly forumId: string;
  readonly bit: CapabilityBit;

  constructor(view: string, forumId: string, bit: CapabilityBit) {
    super(`View "${view}" read capability "${bit}" on forum ${forumId} without declaring it`);
    this.name = "UndeclaredCapabilityError";
    this.view = view;
    this.forumId = forumId;
    this.bit = bit;
  }
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function depKey(forumId: string, bit: CapabilityBit): string {
  return `${forumId}:${bit}`;
}

function compareDeps(left: CapabilityDep, right: CapabilityDep): number {
  const forum = left.forumId.localeCompare(right.forumId);
  return forum === 0 ? capabilityBitIndex(left.bit) - capabilityBitIndex(right.bit) : forum;
}

/**
 * Wraps one viewer's capability bitmap for a render (ADR 0005, 0006).
 *
 * Password unlocks are folded into the effective `read` bit here: masks grant the base bit and
 * a password forum additionally requires the session unlock. Reading a password forum records
 * the unlock state, so locked and unlocked viewers never share a variant, and any request that
 * carries an unlock grant is excluded from the CDN.
 *
 * With declared `deps`, any undeclared bit read during rendering throws in dev/test. The
 * variant key then hashes only the declared bits.
 */
export class CapabilityView {
  private readonly snapshot: CapabilitySnapshot;
  private readonly viewName: string;
  private readonly deps: readonly CapabilityDep[] | null;
  private readonly depKeys: ReadonlySet<string> | null;
  private readonly enforceDeps: boolean;
  private readonly reads = new Map<string, Map<CapabilityBit, RecordedCapabilityRead>>();

  constructor(options: CapabilityViewOptions) {
    this.snapshot = options;
    this.viewName = options.view ?? "view";
    this.deps = options.deps ?? null;
    this.depKeys =
      options.deps === undefined
        ? null
        : new Set(options.deps.map((dep) => depKey(dep.forumId, dep.bit)));
    this.enforceDeps = options.enforceDeps ?? options.deps !== undefined;
  }

  get tree(): ForumTree {
    return this.snapshot.tree;
  }

  /** True for any viewer holding at least one unlock grant (ADR 0006: never CDN-cached). */
  get hasUnlockGrant(): boolean {
    return this.snapshot.unlocked.size > 0;
  }

  isCdnCacheable(): boolean {
    return !this.hasUnlockGrant;
  }

  read(forumId: string): boolean {
    return this.has(forumId, "read");
  }

  has(forumId: string, bit: CapabilityBit): boolean {
    this.assertDeclared(forumId, bit);

    if (isModeratorPower(bit)) {
      const read = this.resolve(forumId, "read");
      this.record(forumId, "read", read);

      if (!read.allowed) {
        this.record(forumId, bit, {
          allowed: false,
          unlockDependent: read.unlockDependent,
          unlocked: read.unlocked,
        });
        return false;
      }
    }

    const resolution = this.resolve(forumId, bit);
    this.record(forumId, bit, resolution);
    return resolution.allowed;
  }

  /**
   * Records an answer that `can()` returned for this render (ADR 0005). The view never answers
   * authorisation questions itself; it only enforces that every bit a page reads was declared
   * and keeps the recorded reads the fallback variant key uses.
   */
  track(forumId: string, bit: CapabilityBit, allowed: boolean): void {
    this.assertDeclared(forumId, bit);

    if (isModeratorPower(bit)) {
      const read = this.resolve(forumId, "read");
      this.assertDeclared(forumId, "read");
      this.record(forumId, "read", read);

      if (!read.allowed) {
        this.record(forumId, bit, {
          allowed: false,
          unlockDependent: read.unlockDependent,
          unlocked: read.unlocked,
        });
        return;
      }
    }

    this.record(forumId, bit, { ...this.resolve(forumId, bit), allowed });
  }

  /** Every bit read during this render, in a stable order. */
  recordedReads(): readonly RecordedCapabilityRead[] {
    return [...this.reads.values()]
      .flatMap((byBit) => [...byBit.values()])
      .sort((left, right) => compareDeps(left, right));
  }

  /**
   * Hashes only the declared capability answers, including the unlock state of password
   * forums. Without declared deps it falls back to the bits actually read during the render.
   */
  visibilityKey(deps?: readonly CapabilityDep[]): string {
    const declared = deps ?? this.deps;
    const parts: string[] = [];

    if (declared !== null) {
      const unique = new Map<string, CapabilityDep>();

      for (const dep of declared) {
        unique.set(depKey(dep.forumId, dep.bit), dep);
      }

      for (const dep of [...unique.values()].sort(compareDeps)) {
        const resolution = this.resolve(dep.forumId, dep.bit);
        const read = isModeratorPower(dep.bit) ? this.resolve(dep.forumId, "read") : null;
        const allowed = read !== null && !read.allowed ? false : resolution.allowed;

        parts.push(`${dep.forumId}|${capabilityBitIndex(dep.bit)}|${allowed ? 1 : 0}`);

        if (resolution.unlockDependent) {
          parts.push(`${dep.forumId}|unlock|${resolution.unlocked ? 1 : 0}`);
        }

        if (read?.unlockDependent === true) {
          parts.push(`${dep.forumId}|read-unlock|${read.unlocked ? 1 : 0}`);
        }
      }
    } else {
      for (const read of this.recordedReads()) {
        parts.push(`${read.forumId}|${capabilityBitIndex(read.bit)}|${read.allowed ? 1 : 0}`);

        if (read.unlockDependent) {
          parts.push(`${read.forumId}|unlock|${read.unlocked ? 1 : 0}`);
        }
      }
    }

    return digest(`capabilities|${parts.join(";")}`);
  }

  private assertDeclared(forumId: string, bit: CapabilityBit): void {
    if (this.depKeys !== null && this.enforceDeps && !this.depKeys.has(depKey(forumId, bit))) {
      throw new UndeclaredCapabilityError(this.viewName, forumId, bit);
    }
  }

  private resolve(forumId: string, bit: CapabilityBit): Resolution {
    const node = this.snapshot.tree.get(forumId);
    const base = hasCapabilityBit(this.snapshot.bits.get(forumId) ?? 0, bit);

    if (node === undefined) {
      return { allowed: false, unlockDependent: false, unlocked: false };
    }

    if (bit === "read" && node.passwordProtected) {
      const unlocked = this.snapshot.unlocked.has(forumId);
      return { allowed: base && unlocked, unlockDependent: true, unlocked };
    }

    return { allowed: base, unlockDependent: false, unlocked: false };
  }

  private record(forumId: string, bit: CapabilityBit, resolution: Resolution): void {
    const byBit = this.reads.get(forumId) ?? new Map<CapabilityBit, RecordedCapabilityRead>();
    byBit.set(bit, { forumId, bit, ...resolution });
    this.reads.set(forumId, byBit);
  }
}

export interface AnnouncementViewer {
  readonly groupIds: readonly string[];
}

export interface AnnouncementAudienceTarget {
  readonly id: string;
  /** Empty means the announcement is shown to everyone (a board-wide notice). */
  readonly targetGroupIds: readonly string[];
}

/**
 * The audience class for announcement blocks (ADR 0005): a hash of the active announcements
 * that target one of the viewer's groups. Members of a targeted group and everyone else get
 * different variants; all viewers with the same matching set share one.
 */
export function announcementAudience(
  viewer: AnnouncementViewer,
  announcements: readonly AnnouncementAudienceTarget[],
): string {
  const groups = new Set(viewer.groupIds);
  const matching = announcements
    .filter(
      (announcement) =>
        announcement.targetGroupIds.length === 0 ||
        announcement.targetGroupIds.some((groupId) => groups.has(groupId)),
    )
    .map((announcement) => announcement.id)
    .sort();

  return digest(`announcements|${matching.join(";")}`);
}
