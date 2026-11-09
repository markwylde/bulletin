import type { SeedModule } from "./framework.ts";

interface SeededLogEntry {
  readonly actor: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly minutesAgo: number;
}

const ENTRIES: readonly SeededLogEntry[] = [
  {
    actor: "Admin",
    action: "board.settings.update",
    targetType: "board",
    targetId: "1",
    summary: {
      before: { boardName: "Bulletin Forum", defaultLocale: "en", offline: false },
      after: { boardName: "Bulletin", defaultLocale: "en", offline: false },
    },
    minutesAgo: 60 * 24 * 2,
  },
  {
    actor: "Super Moderator",
    action: "i18n.override.update",
    targetType: "i18n_key",
    targetId: null,
    summary: {
      key: "user.placeholder.title",
      before: { en: null, es: null, fr: null },
      after: { en: "Bulletin Community", es: null, fr: null },
    },
    minutesAgo: 60 * 6,
  },
  {
    actor: "Admin",
    action: "i18n.override.revert",
    targetType: "i18n_key",
    targetId: null,
    summary: {
      key: "user.placeholder.title",
      before: { en: "Bulletin Community", es: null, fr: null },
      after: { en: null, es: null, fr: null },
    },
    minutesAgo: 45,
  },
];

/**
 * A few realistic audit rows so the dashboard and log view are populated on a fresh
 * `docker compose up --watch`. Historical summaries do not need to match current settings.
 */
export const adminLogSeedModule: SeedModule = {
  name: "admin_log",
  dependsOn: ["base", "members"],
  async run({ sql }) {
    const existing = (await sql`SELECT 1 FROM core.admin_log LIMIT 1`) as unknown[];

    if (existing.length > 0) {
      return;
    }

    const members = (await sql`
      SELECT id, display_name
      FROM core.members
      WHERE display_name IN ('Admin', 'Super Moderator')
    `) as Array<{ id: string; display_name: string }>;
    const byName = new Map(members.map((member) => [member.display_name, member.id]));

    for (const entry of ENTRIES) {
      const actorId = byName.get(entry.actor);

      if (actorId === undefined) {
        throw new Error(`Admin log seed actor ${entry.actor} is missing`);
      }

      await sql`
        INSERT INTO core.admin_log (
          actor_member_id, action, target_type, target_id, summary, created_at
        )
        VALUES (
          ${actorId}, ${entry.action}, ${entry.targetType}, ${entry.targetId},
          ${entry.summary}::jsonb, now() - make_interval(mins => ${entry.minutesAgo})
        )
      `;
    }
  },
};
