import type { SeedModule } from "./framework.ts";

interface SeedEmoticon {
  readonly code: string;
  readonly alt: string;
  readonly storageKey: string;
  readonly png: string;
}

/** A 1×1 PNG is enough for the fixture; the mock serves the bytes and the editor scales it. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=";

const EMOTICONS: readonly SeedEmoticon[] = [
  { code: "smile", alt: "Smile", storageKey: "emoticon/seed-smile", png: PNG },
  { code: "wink", alt: "Wink", storageKey: "emoticon/seed-wink", png: PNG },
  { code: "sad", alt: "Sad", storageKey: "emoticon/seed-sad", png: PNG },
];

/** The default staff-managed emoticon set used by the editor and seed fixtures. */
export const emoticonSeedModule: SeedModule = {
  name: "emoticons",
  dependsOn: ["base"],
  async run({ sql, storage }) {
    const existing = (await sql`
      SELECT 1 FROM core.emoticon_sets WHERE key = 'default' LIMIT 1
    `) as unknown[];

    if (existing.length > 0) {
      return;
    }

    const [set] = (await sql`
      INSERT INTO core.emoticon_sets (key, title, position, editor_visible)
      VALUES ('default', 'Default emoticons', 0, true)
      RETURNING id
    `) as Array<{ id: string }>;

    if (set === undefined) {
      throw new Error("Could not seed the default emoticon set");
    }

    for (const [position, emoticon] of EMOTICONS.entries()) {
      if (storage !== undefined) {
        await storage.put(emoticon.storageKey, Buffer.from(emoticon.png, "base64"), {
          contentType: "image/png",
        });
      }

      await sql`
        INSERT INTO core.emoticons (
          set_id, code, alt, storage_key, content_type, position
        )
        VALUES (
          ${set.id}, ${emoticon.code}, ${emoticon.alt}, ${emoticon.storageKey},
          'image/png', ${position}
        )
        ON CONFLICT (code) DO NOTHING
      `;
    }
  },
};
