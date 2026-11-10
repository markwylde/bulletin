import { type CapabilityBit, capabilityBitIndex, hasCapabilityBit } from "./actions.ts";
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

export interface RecordedCapabilityRead {
  readonly forumId: string;
  readonly bit: CapabilityBit;
  readonly allowed: boolean;
  /** True when the answer came from the session unlock rather than the mask bitmap. */
  readonly unlockDependent: boolean;
  readonly unlocked: boolean;
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * Wraps one viewer's capability bitmap for a render (ADR 0005, 0006).
 *
 * Password unlocks are folded into the effective `read` bit here: masks grant the base bit and
 * a password forum additionally requires the session unlock. Reading a password forum records
 * the unlock state, so locked and unlocked viewers never share a variant, and any request that
 * carries an unlock grant is excluded from the CDN.
 */
export class CapabilityView {
  private readonly snapshot: CapabilitySnapshot;
  private readonly reads = new Map<string, Map<CapabilityBit, RecordedCapabilityRead>>();

  constructor(snapshot: CapabilitySnapshot) {
    this.snapshot = snapshot;
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
    const node = this.snapshot.tree.get(forumId);
    const base = hasCapabilityBit(this.snapshot.bits.get(forumId) ?? 0, bit);

    if (node === undefined) {
      this.record(forumId, bit, false, false, false);
      return false;
    }

    if (bit === "read" && node.passwordProtected) {
      const unlocked = this.snapshot.unlocked.has(forumId);
      const allowed = base && unlocked;
      this.record(forumId, bit, allowed, true, unlocked);
      return allowed;
    }

    this.record(forumId, bit, base, false, false);
    return base;
  }

  /** Every bit read during this render, in a stable order. */
  recordedReads(): readonly RecordedCapabilityRead[] {
    return [...this.reads.values()]
      .flatMap((byBit) => [...byBit.values()])
      .sort((left, right) => {
        const forum = left.forumId.localeCompare(right.forumId);
        return forum === 0 ? capabilityBitIndex(left.bit) - capabilityBitIndex(right.bit) : forum;
      });
  }

  /**
   * A hash of the capability answers this render actually used, including the unlock state of
   * password forums. Two viewers with the same answers share a variant; a locked viewer never
   * shares one with an unlocked viewer (ADR 0005, 0006).
   */
  visibilityKey(): string {
    const parts = this.recordedReads().flatMap((read) => {
      const entries = [`${read.forumId}|${capabilityBitIndex(read.bit)}|${read.allowed ? 1 : 0}`];

      if (read.unlockDependent) {
        entries.push(`${read.forumId}|unlock|${read.unlocked ? 1 : 0}`);
      }

      return entries;
    });

    return digest(`capabilities|${parts.join(";")}`);
  }

  private record(
    forumId: string,
    bit: CapabilityBit,
    allowed: boolean,
    unlockDependent: boolean,
    unlocked: boolean,
  ): void {
    const byBit = this.reads.get(forumId) ?? new Map<CapabilityBit, RecordedCapabilityRead>();
    byBit.set(bit, { forumId, bit, allowed, unlockDependent, unlocked });
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
