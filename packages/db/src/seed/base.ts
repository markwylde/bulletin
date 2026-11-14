import type { SeedSize } from "@bulletin/config";
import type { StorageClient } from "@bulletin/storage";
import { SQL } from "bun";
import { adminLogSeedModule } from "./admin-log.ts";
import { apiSeedModule } from "./api.ts";
import { attachmentSeedModule } from "./attachments.ts";
import { conversationSeedModule } from "./conversations.ts";
import { demoThemesSeedModule } from "./demo-themes.ts";
import { emoticonSeedModule } from "./emoticons.ts";
import { flagsSeedModule } from "./flags.ts";
import { forumExtrasSeedModule } from "./forum-extras.ts";
import { forumSeedModule } from "./forums.ts";
import { runSeeds, type SeedModule, SeedRegistry, type SeedResult } from "./framework.ts";
import { groupsSeedModule } from "./groups.ts";
import { membersSeedModule } from "./members.ts";
import { moderationSeedModule } from "./moderation.ts";
import { moderatorAssignmentsSeedModule } from "./moderator-assignments.ts";
import { notificationsSeedModule } from "./notifications.ts";
import { pluginSeedModule } from "./plugins.ts";
import { profilesSeedModule } from "./profiles.ts";
import { pushSeedModule } from "./push.ts";
import { reactionsSeedModule } from "./reactions.ts";
import { reputationSeedModule } from "./reputation.ts";
import { syncDefaultTheme, themesSeedModule } from "./themes.ts";
import { topicsSeedModule } from "./topics.ts";

export const baseSeedModule: SeedModule = {
  name: "base",
  async run({ sql }) {
    await sql`
      INSERT INTO core.board_settings (
        id, board_name, board_description, default_locale, offline, offline_message
      )
      VALUES (
        1, 'Bulletin', 'A friendly place to talk about everything Bulletin.',
        'en', false, ''
      )
      ON CONFLICT (id) DO NOTHING
    `;
  },
};

function seedSize(): SeedSize {
  const value = Bun.env.SEED_SIZE;
  return value === "small" || value === "large" ? value : "default";
}

export interface BaseSeedOptions {
  readonly storage?: StorageClient;
  readonly databaseUrl: string;
  readonly seed?: number;
  readonly size?: SeedSize;
}

/** Runs the foundation's base seed modules against a database after migrations. */
export async function runBaseSeed(options: BaseSeedOptions): Promise<SeedResult> {
  const sql = new SQL(options.databaseUrl, { connectionTimeout: 5 });

  try {
    const result = await runSeeds({
      sql,
      registry: new SeedRegistry([
        baseSeedModule,
        forumSeedModule,
        emoticonSeedModule,
        reactionsSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        topicsSeedModule,
        apiSeedModule,
        reputationSeedModule,
        profilesSeedModule,
        notificationsSeedModule,
        pushSeedModule,
        attachmentSeedModule,
        conversationSeedModule,
        moderationSeedModule,
        adminLogSeedModule,
        flagsSeedModule,
        themesSeedModule,
        demoThemesSeedModule,
        pluginSeedModule,
      ]),
      seed: options.seed ?? 42,
      size: options.size ?? "default",
      ...(options.storage === undefined ? {} : { storage: options.storage }),
    });

    // The seed is a no-op on a seeded database, but the default theme must still follow the
    // repository after an upgrade (ADR 0008). A hash match makes this a single read.
    await syncDefaultTheme(sql);

    return result;
  } finally {
    await sql.close();
  }
}

/** Runs the foundation's base seed modules against a database after migrations. */
export async function runBaseSeedFromEnv(databaseUrl: string): Promise<SeedResult> {
  return runBaseSeed({
    databaseUrl,
    seed: Number(Bun.env.SEED ?? 42),
    size: seedSize(),
  });
}
