/**
 * The sample plugins the marketplace publishes (ADR 0009). The demo seed installs every sample
 * except the `available` ones, which are left for staff to install from the marketplace.
 * One shared metadata source keeps the seeded rows, catalog entries and docs in sync.
 */

export type SamplePluginId = "hide-post-count" | "welcome-bot" | "tip-jar" | "topic-notice";

export interface SamplePlugin {
  readonly id: SamplePluginId;
  readonly name: string;
  readonly version: string;
  readonly sdkVersion: string;
  readonly description: string;
  readonly author: string;
  /** The seeded state; `available` samples are published but not seeded. */
  readonly state: "disabled" | "active" | "available";
  readonly capabilities: readonly string[];
  readonly events: readonly string[];
  readonly jobs: readonly { readonly name: string; readonly schedule?: string }[];
  readonly forumActions: readonly string[];
  readonly flags: readonly string[];
  readonly templateFragments: readonly {
    readonly name: string;
    readonly kind: "hook" | "override";
    readonly body: string;
    readonly deps?: readonly string[];
  }[];
  readonly personalData: readonly { readonly table: string; readonly memberColumn: string }[];
  readonly settings: Readonly<Record<string, unknown>> | null;
  readonly adminPages?: readonly {
    readonly id: string;
    readonly kind: "table" | "log" | "form";
    readonly titleKey: string;
    readonly definition: Readonly<Record<string, unknown>>;
  }[];
}

const SETTINGS = (
  id: string,
  titleKey: string,
  fields: readonly Record<string, unknown>[],
): Record<string, unknown> => ({
  id,
  extensionPoint: "acp.groups.settings",
  sections: [{ id: "main", titleKey, fields }],
});

export const SAMPLE_PLUGINS: readonly SamplePlugin[] = [
  {
    id: "hide-post-count",
    name: "Hide post count",
    version: "1.0.0",
    sdkVersion: "^2.0.0",
    description: "Overrides the post userbar fragment so post counts are not shown.",
    author: "Bulletin samples",
    state: "disabled",
    capabilities: ["template"],
    events: [],
    jobs: [],
    forumActions: [],
    flags: [],
    templateFragments: [
      {
        name: "post.userbar",
        kind: "override",
        body: '<style>.bl-author-card__posts{display:none!important}</style><span class="bl-post-userbar" data-post-userbar></span>',
        deps: [],
      },
    ],
    personalData: [],
    settings: null,
  },
  {
    id: "welcome-bot",
    name: "Welcome bot",
    version: "1.0.0",
    sdkVersion: "^2.0.0",
    description: "Welcomes new members and keeps a greeting history in its own schema.",
    author: "Bulletin samples",
    state: "active",
    capabilities: ["events", "jobs", "core.read", "db", "settings"],
    events: ["member.created"],
    jobs: [{ name: "digest" }],
    forumActions: [],
    flags: [],
    templateFragments: [],
    personalData: [{ table: "greetings", memberColumn: "member_id" }],
    settings: SETTINGS("welcome-bot", "plugin.welcome.settings.title", [
      {
        id: "greeting",
        type: "text",
        labelKey: "plugin.welcome.greeting",
        required: true,
        maxLength: 200,
      },
      {
        id: "enabled",
        type: "toggle",
        labelKey: "plugin.welcome.enabled",
      },
    ]),
  },
  {
    id: "tip-jar",
    name: "Tip jar",
    version: "1.0.0",
    sdkVersion: "^2.0.0",
    description: "Shows a sandboxed tip button on posts and records tips in its own table.",
    author: "Bulletin samples",
    state: "active",
    capabilities: ["template", "route", "client", "core.read", "db", "settings"],
    events: [],
    jobs: [],
    forumActions: ["can_tip"],
    flags: ["tip_jar"],
    templateFragments: [
      {
        name: "post.after.body",
        kind: "hook",
        body: '{% island "PluginApp", pluginId: "tip-jar", version: "1", app: "client/index.html", viewJson: "{}" %}',
        deps: ["tips"],
      },
    ],
    personalData: [{ table: "tips", memberColumn: "member_id" }],
    adminPages: [
      {
        id: "recent-tips",
        kind: "table",
        titleKey: "plugin.tips.page.recent",
        definition: {
          columns: [
            { id: "postId", labelKey: "plugin.tips.column.post" },
            { id: "amount", labelKey: "plugin.tips.column.amount" },
          ],
          rows: [{ postId: "1", amount: "5.00" }],
        },
      },
    ],
    settings: SETTINGS("tip-jar", "plugin.tips.settings.title", [
      {
        id: "currency",
        type: "select",
        labelKey: "plugin.tips.currency",
        options: [
          { value: "EUR", labelKey: "plugin.tips.currency.eur" },
          { value: "USD", labelKey: "plugin.tips.currency.usd" },
        ],
      },
    ]),
  },
  {
    id: "topic-notice",
    name: "Topic list notice",
    version: "1.0.0",
    sdkVersion: "^2.0.0",
    description:
      "Replaces the demo topic list's stand-in hook fragment. Not seeded: install it from the marketplace.",
    author: "Bulletin samples",
    state: "available",
    capabilities: ["template"],
    events: [],
    jobs: [],
    forumActions: [],
    flags: [],
    templateFragments: [
      {
        name: "demo.after.topics",
        kind: "hook",
        body: '<p class="bl-hook" data-demo-hook data-plugin-notice="topic-notice">{% t "demo.hook" %}</p>',
        deps: [],
      },
    ],
    personalData: [],
    settings: null,
  },
];

export function samplePlugin(id: string): SamplePlugin | undefined {
  return SAMPLE_PLUGINS.find((plugin) => plugin.id === id);
}
