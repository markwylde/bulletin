import type { SeedModule } from "./framework.ts";

interface SeedReaction {
  readonly key: string;
  readonly icon: string;
  readonly labelKey: string;
}

/**
 * The default reaction set staff can edit in the ACP. Weights stay 0 until the board setting
 * that ties reactions to reputation is enabled (change `reactions-reputation`, task 2.2).
 */
const REACTIONS: readonly SeedReaction[] = [
  { key: "like", icon: "👍", labelKey: "reaction.label.like" },
  { key: "thanks", icon: "🙏", labelKey: "reaction.label.thanks" },
  { key: "love", icon: "❤️", labelKey: "reaction.label.love" },
  { key: "laugh", icon: "😄", labelKey: "reaction.label.laugh" },
  { key: "wow", icon: "😮", labelKey: "reaction.label.wow" },
  { key: "sad", icon: "😢", labelKey: "reaction.label.sad" },
  { key: "confused", icon: "😕", labelKey: "reaction.label.confused" },
  { key: "angry", icon: "😠", labelKey: "reaction.label.angry" },
];

/** The staff-managed default reaction set; safe to run on a board that already has reactions. */
export const reactionsSeedModule: SeedModule = {
  name: "reactions",
  dependsOn: ["base"],
  async run({ sql }) {
    for (const [position, reaction] of REACTIONS.entries()) {
      await sql`
        INSERT INTO core.reactions (key, icon, label_key, weight, position, enabled)
        VALUES (${reaction.key}, ${reaction.icon}, ${reaction.labelKey}, 0, ${position}, true)
        ON CONFLICT (key) DO NOTHING
      `;
    }
  },
};
