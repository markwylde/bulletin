/**
 * The three sample plugins the seed installs and the marketplace publishes (ADR 0009).
 * One shared metadata source keeps the seeded rows, catalog entries and docs in sync.
 */

export type SamplePluginId = "hide-post-count" | "welcome-bot" | "tip-jar";

export interface SamplePlugin {
  readonly id: SamplePluginId;
  readonly name: string;
  readonly version: string;
  readonly sdkVersion: string;
  readonly description: string;
  readonly author: string;
  readonly state: "disabled" | "active";
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
        body: '<span class="bl-post-userbar" data-post-userbar></span>',
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
    capabilities: ["events", "jobs", "core.read", "settings"],
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
    capabilities: ["template", "route", "client", "core.read", "settings"],
    events: [],
    jobs: [],
    forumActions: ["can_tip"],
    flags: ["tip_jar"],
    templateFragments: [
      {
        name: "post.after.body",
        kind: "hook",
        body: '<bl-plugin-app data-plugin-id="tip-jar" data-version="1" data-app="client/index.html" data-view="{}"></bl-plugin-app>',
        deps: ["tips"],
      },
    ],
    personalData: [{ table: "tips", memberColumn: "member_id" }],
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
];

export function samplePlugin(id: string): SamplePlugin | undefined {
  return SAMPLE_PLUGINS.find((plugin) => plugin.id === id);
}
