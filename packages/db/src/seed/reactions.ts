import type { SeedModule } from "./framework.ts";

interface SeedReaction {
  readonly key: string;
  readonly icon: string;
  readonly labelKey: string;
  readonly weight: -1 | 0 | 1;
}

/**
 * The default reaction set staff can edit in the ACP. Positive reactions add reputation and the
 * negative ones take it away; the seed turns the board's reaction link on so the totals appear
 * on a fresh board (task 4.2).
 */
const REACTIONS: readonly SeedReaction[] = [
  { key: "like", icon: "👍", labelKey: "reaction.label.like", weight: 1 },
  { key: "thanks", icon: "🙏", labelKey: "reaction.label.thanks", weight: 1 },
  { key: "love", icon: "❤️", labelKey: "reaction.label.love", weight: 1 },
  { key: "laugh", icon: "😄", labelKey: "reaction.label.laugh", weight: 1 },
  { key: "wow", icon: "😮", labelKey: "reaction.label.wow", weight: 0 },
  { key: "sad", icon: "😢", labelKey: "reaction.label.sad", weight: -1 },
  { key: "confused", icon: "😕", labelKey: "reaction.label.confused", weight: -1 },
  { key: "angry", icon: "😠", labelKey: "reaction.label.angry", weight: -1 },
];

/** The staff-managed default reaction set; safe to run on a board that already has reactions. */
export const reactionsSeedModule: SeedModule = {
  name: "reactions",
  dependsOn: ["base"],
  async run({ sql }) {
    for (const [position, reaction] of REACTIONS.entries()) {
      await sql`
        INSERT INTO core.reactions (key, icon, label_key, weight, position, enabled)
        VALUES (
          ${reaction.key}, ${reaction.icon}, ${reaction.labelKey}, ${reaction.weight},
          ${position}, true
        )
        ON CONFLICT (key) DO NOTHING
      `;
    }
  },
};
