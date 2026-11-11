import {
  type ForumAction,
  forumActionMask,
  MODERATOR_POWERS,
  moderatorSettingKey,
} from "@bulletin/domain/permissions";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

interface GroupSeed {
  readonly key: string;
  readonly title: string;
  readonly displayOrder: number;
  readonly colour: string | null;
  readonly icon: string | null;
}

const GROUPS: readonly GroupSeed[] = [
  { key: "guests", title: "Guests", displayOrder: 10, colour: null, icon: null },
  {
    key: "members",
    title: "Members",
    displayOrder: 20,
    colour: null,
    icon: "user",
  },
  {
    key: "regulars",
    title: "Regulars",
    displayOrder: 25,
    colour: "#2f855a",
    icon: "star",
  },
  { key: "vip", title: "VIP", displayOrder: 30, colour: "#c0a000", icon: "crown" },
  {
    key: "banned",
    title: "Banned",
    displayOrder: 40,
    colour: "#a02a2a",
    icon: "ban",
  },
  {
    key: "moderators",
    title: "Moderators",
    displayOrder: 45,
    colour: "#3157c7",
    icon: "shield",
  },
  {
    key: "super_moderators",
    title: "Super Moderators",
    displayOrder: 50,
    colour: "#7d3fc4",
    icon: "shield",
  },
  {
    key: "administrators",
    title: "Administrators",
    displayOrder: 60,
    colour: "#a02a2a",
    icon: "key",
  },
];

const MASKS = [
  {
    key: "guest",
    title: "Guest",
    description: "Read-only access for guests.",
    displayOrder: 5,
  },
  {
    key: "standard",
    title: "Standard",
    description: "Read and post access for members.",
    displayOrder: 10,
  },
  {
    key: "staff",
    title: "Staff",
    description: "Full access for staff groups.",
    displayOrder: 20,
  },
] as const;

const GUEST_GROUPS = ["guests"];
const STANDARD_GROUPS = ["members", "regulars", "vip", "moderators", "super_moderators"];
const STAFF_GROUPS = ["administrators", "super_moderators"];

async function groupIds(sql: SQL): Promise<Map<string, string>> {
  const rows = (await sql`
    SELECT key, id FROM core.groups
  `) as Array<{ key: string; id: string }>;
  return new Map(rows.map((row) => [row.key, row.id]));
}

async function setForumMatrix(
  sql: SQL,
  forumId: string,
  maskId: string,
  actions: readonly ForumAction[],
  inherits = false,
): Promise<void> {
  await sql`
    INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
    VALUES (${forumId}, ${maskId}, ${forumActionMask(actions)}, ${inherits})
    ON CONFLICT (forum_id, mask_id) DO UPDATE
      SET actions = EXCLUDED.actions, inherits = EXCLUDED.inherits, updated_at = now()
  `;
}

/**
 * Groups, masks, the seeded forum matrix, global moderator powers and promotion rules.
 * Runs after the fixture forums and before members, so `Members` is promoted to `Regulars`.
 */
export const groupsSeedModule: SeedModule = {
  name: "groups",
  dependsOn: ["base", "forums"],
  async run({ sql }) {
    for (const group of GROUPS) {
      await sql`
        INSERT INTO core.groups (key, title, is_system, display_order, name_colour, icon)
        VALUES (
          ${group.key}, ${group.title},
          ${["guests", "members", "banned", "super_moderators", "administrators"].includes(group.key)},
          ${group.displayOrder}, ${group.colour}, ${group.icon}
        )
        ON CONFLICT (key) DO UPDATE
          SET title = EXCLUDED.title,
              display_order = EXCLUDED.display_order,
              name_colour = EXCLUDED.name_colour,
              icon = EXCLUDED.icon
      `;
    }

    const ids = await groupIds(sql);
    const masks = new Map<string, string>();

    for (const mask of MASKS) {
      const [row] = (await sql`
        INSERT INTO core.masks (key, title, description, display_order)
        VALUES (${mask.key}, ${mask.title}, ${mask.description}, ${mask.displayOrder})
        ON CONFLICT (key) DO UPDATE
          SET title = EXCLUDED.title,
              description = EXCLUDED.description,
              display_order = EXCLUDED.display_order
        RETURNING id
      `) as Array<{ id: string }>;

      if (row === undefined) {
        throw new Error(`Could not seed mask ${mask.key}`);
      }

      masks.set(mask.key, row.id);
    }

    for (const [maskKey, groupKeys] of [
      ["guest", GUEST_GROUPS],
      ["standard", STANDARD_GROUPS],
      ["staff", STAFF_GROUPS],
    ] as const) {
      const maskId = masks.get(maskKey);

      if (maskId === undefined) {
        throw new Error(`Missing mask ${maskKey}`);
      }

      for (const groupKey of groupKeys) {
        const groupId = ids.get(groupKey);

        if (groupId === undefined) {
          throw new Error(`Missing group ${groupKey}`);
        }

        await sql`
          INSERT INTO core.group_masks (group_id, mask_id)
          VALUES (${groupId}, ${maskId})
          ON CONFLICT DO NOTHING
        `;
      }
    }

    // Matrix rows live on the four category roots; every forum inherits from its category.
    const roots = (await sql`
      SELECT id, slug FROM core.forums WHERE parent_id IS NULL AND type = 'category'
    `) as Array<{ id: string; slug: string }>;
    const rootBySlug = new Map(roots.map((root) => [root.slug, root.id]));
    const guest = masks.get("guest");
    const standard = masks.get("standard");
    const staff = masks.get("staff");
    const guestRoots = ["community", "support"] as const;
    const standardRoots = ["community", "support", "archive"] as const;
    const staffRoots = ["community", "support", "staff-area", "archive"] as const;

    for (const slug of guestRoots) {
      const forumId = rootBySlug.get(slug);

      if (guest !== undefined && forumId !== undefined) {
        await setForumMatrix(sql, forumId, guest, ["show", "read", "download"]);
      }
    }

    for (const slug of standardRoots) {
      const forumId = rootBySlug.get(slug);

      if (standard !== undefined && forumId !== undefined) {
        await setForumMatrix(sql, forumId, standard, [
          "show",
          "read",
          "start",
          "reply",
          "upload",
          "download",
          "vote",
        ]);
      }
    }

    for (const slug of staffRoots) {
      const forumId = rootBySlug.get(slug);

      if (staff !== undefined && forumId !== undefined) {
        await setForumMatrix(sql, forumId, staff, [
          "show",
          "read",
          "start",
          "reply",
          "upload",
          "download",
          "vote",
        ]);
      }
    }

    for (const groupKey of ["super_moderators", "administrators"]) {
      const groupId = ids.get(groupKey);

      if (groupId === undefined) {
        continue;
      }

      for (const power of MODERATOR_POWERS) {
        await sql`
          INSERT INTO core.group_settings (group_id, key, value)
          VALUES (${groupId}, ${moderatorSettingKey(power)}, 'true'::jsonb)
          ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `;
      }
    }

    const displayColours: Array<[string, string]> = [
      ["regulars", "green"],
      ["vip", "gold"],
      ["moderators", "blue"],
    ];

    for (const [groupKey, colour] of displayColours) {
      const groupId = ids.get(groupKey);

      if (groupId === undefined) {
        continue;
      }

      await sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${groupId}, 'display.name_colour', to_jsonb(${colour}::text))
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
    }

    // Upload limits make the editor usable on a fresh board (attachments-avatars, task 6.1
    // exposes them in the ACP). Quota is total bytes, per-file is one file.
    for (const [groupKey, quotaMb, perFileKb, avatarKb, avatarEdge] of [
      ["members", 50, 10_240, 512, 512],
      ["regulars", 100, 10_240, 512, 512],
      ["vip", 200, 20_480, 1_024, 1_024],
      ["moderators", 200, 20_480, 1_024, 1_024],
      ["super_moderators", 500, 51_200, 2_048, 2_048],
      ["administrators", 500, 51_200, 2_048, 2_048],
    ] as const) {
      const groupId = ids.get(groupKey);

      if (groupId === undefined) {
        continue;
      }

      for (const [key, value] of [
        ["posting.upload_quota_mb", quotaMb],
        ["posting.upload_per_file_kb", perFileKb],
        ["members.avatar_max_kb", avatarKb],
        ["members.avatar_max_width", avatarEdge],
        ["members.avatar_max_height", avatarEdge],
      ] as const) {
        await sql`
          INSERT INTO core.group_settings (group_id, key, value)
          VALUES (${groupId}, ${key}, to_jsonb(${value}::int))
          ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `;
      }

      for (const key of ["posting.upload_images", "posting.upload_documents"] as const) {
        await sql`
          INSERT INTO core.group_settings (group_id, key, value)
          VALUES (${groupId}, ${key}, 'true'::jsonb)
          ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `;
      }
    }

    // Staff groups cannot be ignored by members (ignore-list spec).
    for (const groupKey of ["moderators", "super_moderators", "administrators"] as const) {
      const groupId = ids.get(groupKey);

      if (groupId === undefined) {
        continue;
      }

      await sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${groupId}, 'members.unignorable', 'true'::jsonb)
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
    }

    // Signature limits by group (task 2.1). Zero would disable signatures entirely.
    for (const [groupKey, limits] of [
      ["members", { chars: 500, lines: 4, images: 1, links: 2 }],
      ["regulars", { chars: 1_000, lines: 6, images: 2, links: 4 }],
      ["vip", { chars: 1_500, lines: 8, images: 3, links: 6 }],
      ["moderators", { chars: 2_000, lines: 10, images: 4, links: 8 }],
      ["super_moderators", { chars: 2_000, lines: 10, images: 4, links: 8 }],
      ["administrators", { chars: 2_000, lines: 10, images: 4, links: 8 }],
    ] as const) {
      const groupId = ids.get(groupKey);

      if (groupId === undefined) {
        continue;
      }

      for (const [key, value] of [
        ["members.signature_max_chars", limits.chars],
        ["members.signature_max_lines", limits.lines],
        ["members.signature_max_images", limits.images],
        ["members.signature_max_links", limits.links],
      ] as const) {
        await sql`
          INSERT INTO core.group_settings (group_id, key, value)
          VALUES (${groupId}, ${key}, to_jsonb(${value}::int))
          ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `;
      }
    }

    const members = ids.get("members");
    const regulars = ids.get("regulars");
    const vip = ids.get("vip");

    for (const [from, to, days] of [
      [members, regulars, 30],
      [regulars, vip, 180],
    ] as const) {
      if (from === undefined || to === undefined) {
        continue;
      }

      const existing = (await sql`
        SELECT 1
        FROM core.promotion_rules
        WHERE from_group_id = ${from} AND to_group_id = ${to}
        LIMIT 1
      `) as unknown[];

      if (existing.length === 0) {
        await sql`
          INSERT INTO core.promotion_rules (
            from_group_id, to_group_id, criteria, position, enabled
          ) VALUES (
            ${from}, ${to}, ${{ days_since_joining: days }}, ${days}, true
          )
        `;
      }
    }
  },
};
