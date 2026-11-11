import { listEditorEmoticons } from "@bulletin/domain/content";
import {
  type CapabilityDep,
  CapabilityView,
  can,
  GUEST_PRINCIPAL,
  loadPermissionSnapshot,
  type ViewerPrincipal,
} from "@bulletin/domain/permissions";
import {
  FIXTURE_DEMO_PASSWORD,
  FIXTURE_FORUM_NODES,
  FIXTURE_FORUM_TREE,
} from "@bulletin/domain/permissions/fixtures";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { UserAppSessionContext } from "../session.ts";
import type { BreadcrumbItem } from "../theme/render.ts";

/** Fixture topic counts per forum; a zero renders the theme's empty state. */
const DEMO_TOPIC_COUNTS: Readonly<Record<string, number>> = {
  "2": 3,
  "3": 3,
  "5": 2,
  "7": 3,
  "8": 3,
};
const DELETED_TOPIC_INDEX = 2;

export interface DemoPageInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  readonly forumId: string;
  /** The moderator tools control toggles the hidden (deleted) fixture topic. */
  readonly showDeleted: boolean;
  /** The view that records capability reads; tests pass a narrowed one to prove enforcement. */
  readonly capabilityView?: CapabilityView;
}

interface DemoBase {
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly title: string;
  /** Hash of the capability answers the page depends on; null for an unknown forum. */
  readonly visibilityKey: string | null;
  /** Whether the deleted fixture topic is shown (a moderator-only request parameter). */
  readonly showDeleted: boolean;
  /** A session unlock grant also makes the response private (ADR 0006). */
  readonly hasUnlockGrant: boolean;
}

/** The states the demo route can render; only `content` contains the required counter. */
export type DemoState = "content" | "locked" | "error";

export interface DemoForumPage extends DemoBase {
  readonly template: "demo";
  readonly state: "content" | "locked";
  readonly viewModel: object;
}

export interface DemoErrorPage extends DemoBase {
  readonly template: "error";
  readonly state: "error";
  readonly status: number;
  readonly viewModel: { readonly code: string; readonly message: string };
}

export type DemoOutcome = DemoForumPage | DemoErrorPage;

/** The capability bits the demo view reads for a forum; the variant key hashes exactly these. */
export function demoCapabilityDeps(forumId: string): readonly CapabilityDep[] {
  const node = FIXTURE_FORUM_TREE.get(forumId);

  if (node === undefined) {
    return [];
  }

  const childNodes = FIXTURE_FORUM_NODES.filter((candidate) => candidate.parentId === node.id);

  return [
    { forumId: node.id, bit: "show" },
    { forumId: node.id, bit: "read" },
    { forumId: node.id, bit: "see_deleted" },
    ...childNodes.flatMap((child) => [
      { forumId: child.id, bit: "show" as const },
      { forumId: child.id, bit: "read" as const },
    ]),
  ];
}

function demoTitle(translate: Translator, id: string): string {
  return translate("demo.forum.title", { id });
}

/** Breadcrumbs for a fixture forum: its ancestors, then the forum itself. */
function demoBreadcrumbs(translate: Translator, forumId: string): readonly BreadcrumbItem[] {
  return [
    ...FIXTURE_FORUM_TREE.ancestors(forumId).map((node) => ({
      label: demoTitle(translate, node.id),
      href: `/_demo/${node.id}`,
    })),
    { label: demoTitle(translate, forumId), href: null },
  ];
}

function errorPage(
  code: string,
  message: string,
  breadcrumbs: readonly BreadcrumbItem[],
  title: string,
  visibilityKey: string | null,
): DemoErrorPage {
  return {
    template: "error",
    state: "error",
    status: code === "not_found" ? 404 : 403,
    title,
    breadcrumbs,
    visibilityKey,
    showDeleted: false,
    hasUnlockGrant: false,
    viewModel: { code, message },
  };
}

/**
 * Builds the demo route's view model over the fixture forum tree (ADR 0008, task 4.2). Every
 * decision goes through `can()` (ADR 0005); the capability view exists only to hash exactly the
 * declared deps into the variant key.
 */
async function editorPage(input: DemoPageInput): Promise<DemoForumPage> {
  const translate = input.translate;
  const title = translate("editor.demo.title");
  const sets = await listEditorEmoticons(input.sql);
  const emoticons = sets.flatMap((set) =>
    set.emoticons.map((emoticon) => ({
      code: emoticon.code,
      src: emoticon.src,
      alt: emoticon.alt,
    })),
  );

  return {
    template: "demo",
    state: "content",
    title,
    breadcrumbs: [],
    visibilityKey: "editor",
    showDeleted: false,
    hasUnlockGrant: false,
    viewModel: {
      forumId: "1",
      forumTitle: title,
      isCategory: false,
      locked: false,
      children: [],
      topics: [],
      showDeleted: false,
      showModTools: false,
      editor: {
        contextKey: "demo:editor",
        initialMarkdown: "# Demo post\n\n:::disabled-plugin\nraw [b]hi[/b]\n:::",
        forumId: "1",
        canUpload: false,
        emoticons,
        flags: { mentions: true, attachments: false },
        labels: {
          editor: translate("editor.label"),
          toolbar: translate("editor.toolbar"),
          wysiwyg: translate("editor.wysiwyg"),
          source: translate("editor.source"),
          bold: translate("editor.bold"),
          italic: translate("editor.italic"),
          heading: translate("editor.heading"),
          link: translate("editor.link"),
          code: translate("editor.code"),
          quote: translate("editor.quote"),
          spoiler: translate("editor.spoiler"),
          list: translate("editor.list"),
          emoticon: translate("editor.emoticon"),
          mention: translate("editor.mention"),
          draftFound: translate("editor.draft.found"),
          restoreDraft: translate("editor.draft.restore"),
          discardDraft: translate("editor.draft.discard"),
          saving: translate("editor.draft.saving"),
          saved: translate("editor.draft.saved"),
          saveFailed: translate("editor.draft.failed"),
          mentionEmpty: translate("editor.mention.empty"),
          mentionLoading: translate("editor.mention.loading"),
          attach: translate("editor.attach"),
          attachHint: translate("editor.attachHint"),
          uploading: translate("editor.upload.uploading"),
          processing: translate("editor.upload.processing"),
          uploadReady: translate("editor.upload.ready"),
          uploadFailed: translate("editor.upload.failed"),
          uploadQuota: translate("editor.upload.quota"),
          uploadQuotaRemaining: translate("editor.upload.quotaRemaining"),
          uploadTooLarge: translate("editor.upload.tooLarge"),
          uploadType: translate("editor.upload.type"),
          uploadRejected: translate("editor.upload.rejected"),
        },
      },
    },
  };
}

export async function buildDemoPage(input: DemoPageInput): Promise<DemoOutcome> {
  if (input.forumId === "editor") {
    return editorPage(input);
  }

  const node = FIXTURE_FORUM_TREE.get(input.forumId);
  const title = input.translate("theme.error.title");
  const notFound = errorPage("not_found", input.translate("theme.error.notFound"), [], title, null);

  if (node === undefined) {
    return notFound;
  }

  const breadcrumbs = demoBreadcrumbs(input.translate, node.id);
  const principal: ViewerPrincipal = input.session?.memberId ?? GUEST_PRINCIPAL;
  const sessionId = input.session?.sessionId ?? null;
  const snapshot = await loadPermissionSnapshot(input.sql, principal, {
    tree: FIXTURE_FORUM_TREE,
    sessionId,
  });
  const childNodes = FIXTURE_FORUM_NODES.filter((candidate) => candidate.parentId === node.id);
  // Every branch below reads one of these bits, and the variant key hashes exactly them.
  const deps = demoCapabilityDeps(node.id);
  const view =
    input.capabilityView ??
    new CapabilityView({
      tree: FIXTURE_FORUM_TREE,
      bits: snapshot.bits,
      unlocked: snapshot.unlocked,
      deps,
      view: "demo",
    });
  const visibilityKey = view.visibilityKey();
  // `can()` alone answers (ADR 0005); recording the answer on the view makes an undeclared
  // dependency throw instead of silently escaping the variant key.
  const allowed = async (
    bit: "show" | "read" | "see_deleted",
    forumId: string,
  ): Promise<boolean> => {
    const answer = await can(input.sql, principal, bit, {
      forumId,
      tree: FIXTURE_FORUM_TREE,
      sessionId,
      snapshot,
    });
    view.track(forumId, bit, answer);
    return answer;
  };
  const readable = await allowed("read", node.id);

  if (!(await allowed("show", node.id))) {
    return errorPage(
      "forbidden",
      input.translate("theme.error.forbidden"),
      breadcrumbs,
      title,
      visibilityKey,
    );
  }

  const forumTitle = demoTitle(input.translate, node.id);
  const isCategory = node.parentId === null;
  const locked = node.passwordProtected && !readable;

  // A forum with `show` but no `read` is a denial; a password forum offers the unlock form.
  if (!isCategory && !locked && !readable) {
    return errorPage(
      "forbidden",
      input.translate("theme.error.forbidden"),
      breadcrumbs,
      title,
      visibilityKey,
    );
  }
  const base = {
    forumId: node.id,
    forumTitle,
    isCategory,
    locked,
    passwordHint: FIXTURE_DEMO_PASSWORD,
    editor: null,
  };

  if (locked) {
    return {
      template: "demo",
      state: "locked",
      title: forumTitle,
      breadcrumbs,
      visibilityKey,
      showDeleted: false,
      hasUnlockGrant: view.hasUnlockGrant,
      viewModel: base,
    };
  }

  const children: Array<{ id: string; label: string; locked: boolean }> = [];

  if (isCategory) {
    for (const child of childNodes) {
      if (!(await allowed("show", child.id))) {
        continue;
      }

      children.push({
        id: child.id,
        label: demoTitle(input.translate, child.id),
        locked: child.passwordProtected && !(await allowed("read", child.id)),
      });
    }
  }

  const canSeeDeleted = await allowed("see_deleted", node.id);
  const showDeleted = input.showDeleted && canSeeDeleted;
  const topicCount = DEMO_TOPIC_COUNTS[node.id] ?? 0;
  const topics = isCategory
    ? []
    : Array.from({ length: topicCount }, (_, index) => ({
        id: `${node.id}0${index + 1}`,
        title: input.translate("demo.topic.title", { id: index + 1 }),
        deleted: index === DELETED_TOPIC_INDEX,
      })).filter((topic) => !topic.deleted || showDeleted);

  return {
    template: "demo",
    state: "content",
    title: forumTitle,
    breadcrumbs,
    visibilityKey,
    showDeleted,
    hasUnlockGrant: view.hasUnlockGrant,
    viewModel: {
      ...base,
      children,
      topics,
      counter: { label: input.translate("demo.counter.label"), start: 0 },
      showModTools: canSeeDeleted,
      showDeleted,
    },
  };
}
