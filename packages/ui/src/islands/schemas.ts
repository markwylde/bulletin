import * as v from "valibot";

/**
 * Island props schemas (ADR 0008): every island in the fixed registry validates untrusted
 * template props against one of these before it renders or hydrates.
 */
export type IslandPropsSchema<TProps extends object = object> = v.BaseSchema<
  unknown,
  TProps,
  v.BaseIssue<unknown>
>;

export const LOCALE_VALUES = ["en", "es", "fr"] as const;

const languageOptionSchema = v.strictObject({
  value: v.picklist(LOCALE_VALUES),
  label: v.pipe(v.string(), v.minLength(1)),
});

export const spikeCounterSchema = v.strictObject({
  label: v.pipe(v.string(), v.trim(), v.minLength(1)),
  start: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
});

export const themeChooserSchema = v.strictObject({
  labels: v.strictObject({
    theme: v.pipe(v.string(), v.trim(), v.minLength(1)),
    scheme: v.pipe(v.string(), v.trim(), v.minLength(1)),
    save: v.pipe(v.string(), v.trim(), v.minLength(1)),
    failed: v.pipe(v.string(), v.trim(), v.minLength(1)),
    system: v.pipe(v.string(), v.trim(), v.minLength(1)),
    light: v.pipe(v.string(), v.trim(), v.minLength(1)),
    dark: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
});

export const languageSwitcherSchema = v.strictObject({
  current: v.picklist(LOCALE_VALUES),
  options: v.pipe(v.array(languageOptionSchema), v.minLength(1)),
  label: v.pipe(v.string(), v.minLength(1)),
  nameRequired: v.pipe(v.string(), v.minLength(1)),
  saveFailed: v.pipe(v.string(), v.minLength(1)),
});

const editorEmoticonSchema = v.strictObject({
  code: v.pipe(v.string(), v.regex(/^[a-z0-9_+-]{1,32}$/i)),
  src: v.pipe(v.string(), v.minLength(1)),
  alt: v.pipe(v.string(), v.minLength(1)),
});

const editorLabelsSchema = v.strictObject({
  editor: v.pipe(v.string(), v.minLength(1)),
  toolbar: v.pipe(v.string(), v.minLength(1)),
  wysiwyg: v.pipe(v.string(), v.minLength(1)),
  source: v.pipe(v.string(), v.minLength(1)),
  bold: v.pipe(v.string(), v.minLength(1)),
  italic: v.pipe(v.string(), v.minLength(1)),
  heading: v.pipe(v.string(), v.minLength(1)),
  link: v.pipe(v.string(), v.minLength(1)),
  code: v.pipe(v.string(), v.minLength(1)),
  quote: v.pipe(v.string(), v.minLength(1)),
  spoiler: v.pipe(v.string(), v.minLength(1)),
  list: v.pipe(v.string(), v.minLength(1)),
  emoticon: v.pipe(v.string(), v.minLength(1)),
  mention: v.pipe(v.string(), v.minLength(1)),
  draftFound: v.pipe(v.string(), v.minLength(1)),
  restoreDraft: v.pipe(v.string(), v.minLength(1)),
  discardDraft: v.pipe(v.string(), v.minLength(1)),
  saving: v.pipe(v.string(), v.minLength(1)),
  saved: v.pipe(v.string(), v.minLength(1)),
  saveFailed: v.pipe(v.string(), v.minLength(1)),
  mentionEmpty: v.pipe(v.string(), v.minLength(1)),
  mentionLoading: v.pipe(v.string(), v.minLength(1)),
  attach: v.pipe(v.string(), v.minLength(1)),
  attachHint: v.pipe(v.string(), v.minLength(1)),
  uploading: v.pipe(v.string(), v.minLength(1)),
  processing: v.pipe(v.string(), v.minLength(1)),
  uploadReady: v.pipe(v.string(), v.minLength(1)),
  uploadFailed: v.pipe(v.string(), v.minLength(1)),
  uploadQuota: v.pipe(v.string(), v.minLength(1)),
  uploadQuotaRemaining: v.pipe(v.string(), v.minLength(1)),
  uploadTooLarge: v.pipe(v.string(), v.minLength(1)),
  uploadType: v.pipe(v.string(), v.minLength(1)),
  uploadRejected: v.pipe(v.string(), v.minLength(1)),
});

export const editorSchema = v.strictObject({
  name: v.optional(v.pipe(v.string(), v.regex(/^[a-z][a-zA-Z0-9_-]{0,63}$/))),
  contextKey: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9:._-]{0,119}$/)),
  initialMarkdown: v.pipe(v.string(), v.maxLength(100_000)),
  forumId: v.optional(v.pipe(v.string(), v.regex(/^\d*$/)), ""),
  conversationId: v.optional(v.pipe(v.string(), v.regex(/^\d*$/)), ""),
  canUpload: v.optional(v.boolean(), false),
  emoticons: v.array(editorEmoticonSchema),
  labels: editorLabelsSchema,
  flags: v.strictObject({ mentions: v.boolean(), attachments: v.boolean() }),
});

export const localeSuggestionSchema = v.strictObject({
  current: v.picklist(LOCALE_VALUES),
  options: v.pipe(v.array(languageOptionSchema), v.minLength(1)),
  message: v.pipe(v.string(), v.minLength(1)),
  accept: v.pipe(v.string(), v.minLength(1)),
  dismiss: v.pipe(v.string(), v.minLength(1)),
});

const reactionOptionSchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^\d+$/)),
  icon: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
  label: v.pipe(v.string(), v.minLength(1)),
  count: v.pipe(v.number(), v.integer(), v.minValue(0)),
  enabled: v.boolean(),
});

const reactionLabelsSchema = v.strictObject({
  bar: v.pipe(v.string(), v.minLength(1)),
  pick: v.pipe(v.string(), v.minLength(1)),
  remove: v.pipe(v.string(), v.minLength(1)),
  whoReacted: v.pipe(v.string(), v.minLength(1)),
  close: v.pipe(v.string(), v.minLength(1)),
  loading: v.pipe(v.string(), v.minLength(1)),
  empty: v.pipe(v.string(), v.minLength(1)),
  failed: v.pipe(v.string(), v.minLength(1)),
  deletedMember: v.pipe(v.string(), v.minLength(1)),
});

/** The reaction bar: totals server-rendered, the member's own reaction via the overlay. */
export const reactionsSchema = v.strictObject({
  postId: v.pipe(v.string(), v.regex(/^\d+$/)),
  canReact: v.boolean(),
  reactions: v.array(reactionOptionSchema),
  labels: reactionLabelsSchema,
  flags: v.strictObject({ reactions: v.boolean() }),
});

const reputationLabelsSchema = v.strictObject({
  giveUp: v.pipe(v.string(), v.minLength(1)),
  giveDown: v.pipe(v.string(), v.minLength(1)),
  givenUp: v.pipe(v.string(), v.minLength(1)),
  givenDown: v.pipe(v.string(), v.minLength(1)),
  failed: v.pipe(v.string(), v.minLength(1)),
  dailyLimit: v.pipe(v.string(), v.minLength(1)),
  minPosts: v.pipe(v.string(), v.minLength(1)),
  negativeNotAllowed: v.pipe(v.string(), v.minLength(1)),
  cannotReceive: v.pipe(v.string(), v.minLength(1)),
  alreadyGiven: v.pipe(v.string(), v.minLength(1)),
  ownPost: v.pipe(v.string(), v.minLength(1)),
});

/** The reputation give controls next to a post; the overlay supplies own/given state. */
export const postReputationSchema = v.strictObject({
  postId: v.pipe(v.string(), v.regex(/^\d+$/)),
  receiverId: v.pipe(v.string(), v.regex(/^\d+$/)),
  canGive: v.boolean(),
  canNegative: v.boolean(),
  locale: v.picklist(LOCALE_VALUES),
  labels: reputationLabelsSchema,
  flags: v.strictObject({ reputation: v.boolean() }),
});

/** A plugin client app slot; the `plugins` flag gates it in the island component. */
export const pluginAppSchema = v.strictObject({
  pluginId: v.pipe(v.string(), v.minLength(1), v.maxLength(49)),
  version: v.pipe(v.string(), v.minLength(1), v.maxLength(20)),
  app: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  viewJson: v.optional(v.pipe(v.string(), v.maxLength(20_000)), "{}"),
});

/** The canonical island names; the template registry and the client runtime must match. */
export const ISLAND_SCHEMAS = {
  SpikeCounter: spikeCounterSchema,
  LanguageSwitcher: languageSwitcherSchema,
  LocaleSuggestion: localeSuggestionSchema,
  Editor: editorSchema,
  Reactions: reactionsSchema,
  PostReputation: postReputationSchema,
  ThemeChooser: themeChooserSchema,
  PluginApp: pluginAppSchema,
} as const;

export type IslandName = keyof typeof ISLAND_SCHEMAS;

export const ISLAND_NAMES: readonly IslandName[] = Object.keys(ISLAND_SCHEMAS) as IslandName[];
