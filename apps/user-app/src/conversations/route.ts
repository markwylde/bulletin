import type { ConversationFolder } from "@bulletin/domain/conversations";
import { loadReplaceWords } from "@bulletin/domain/filters";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import { conversationContract, conversationsContract } from "../contracts.ts";
import { loadViewerFlags } from "../flags.ts";
import type { UserAppSessionContext } from "../session.ts";
import { pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { renderThemedNotFound } from "../theme/not-found.ts";
import { boardNameFrom, renderThemedPage } from "../theme/render.ts";
import { buildConversationPage, buildInboxPage } from "./page.ts";

export interface ConversationRouteInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  /** The board's configured name, when the caller has loaded it. */
  readonly boardName?: string | null;
}

export interface ConversationPageResult {
  readonly kind: "page";
  readonly status: 200 | 404;
  readonly html: string;
  readonly title: string;
  readonly boardName: string;
  readonly errors: readonly string[];
}

async function notFoundPage(
  input: ConversationRouteInput,
  route: typeof conversationsContract | typeof conversationContract,
): Promise<ConversationPageResult> {
  const notFound = await renderThemedNotFound({
    sql: input.sql,
    locale: input.locale,
    translate: input.translate,
    route,
  });

  return {
    kind: "page",
    status: 404,
    html: notFound.html,
    title: notFound.title,
    boardName: notFound.boardName,
    errors: notFound.errors,
  };
}

/** The private inbox route; 404 while the `conversations` flag is off (ADR 0010). */
export async function renderConversationsRoute(
  input: ConversationRouteInput & {
    readonly folder: ConversationFolder;
    readonly query?: string;
  },
): Promise<ConversationPageResult> {
  const flags = await loadViewerFlags(input.sql, input.session);

  if (flags.values.conversations !== true) {
    return notFoundPage(input, conversationsContract);
  }

  const boardName = boardNameFrom(input.boardName ?? null, input.translate);
  const page = await buildInboxPage({
    sql: input.sql,
    memberId: input.session.memberId,
    locale: input.locale,
    translate: input.translate,
    folder: input.folder,
    mentionsEnabled: flags.values.mentions === true,
    ...(input.query === undefined ? {} : { query: input.query }),
  });
  const rendered = await renderCachedPage({
    tags: [`member:${input.session.memberId}`],
    cache: null,
    tagVersions: null,
    shell: { visitor: "member", authState: "authenticated" },
    prepare: async () => ({
      variant: pageVariant({
        route: conversationsContract.route,
        visibilityKey: "member",
        theme: null,
        pluginsGeneration: input.pluginsGeneration,
        locale: input.locale,
        colourScheme: input.colourScheme,
        renderFlagsHash: flags.hash,
      }),
      data: undefined,
    }),
    render: async () => {
      const themed = await renderThemedPage({
        sql: input.sql,
        boardName,
        locale: input.locale,
        translate: input.translate,
        template: "conversations",
        viewModel: { title: page.title, ...page.viewModel, flags: flags.values },
        breadcrumbs: page.breadcrumbs,
        route: conversationsContract,
      });

      return { html: themed.html, errors: themed.errors };
    },
  });

  return {
    kind: "page",
    status: 200,
    html: rendered.html,
    title: page.title,
    boardName,
    errors: rendered.errors,
  };
}

/** One private conversation; unknown IDs and a disabled flag both return 404 (design). */
export async function renderConversationRoute(
  input: ConversationRouteInput & { readonly ref: string },
): Promise<ConversationPageResult> {
  const flags = await loadViewerFlags(input.sql, input.session);

  if (flags.values.conversations !== true) {
    return notFoundPage(input, conversationContract);
  }

  const boardName = boardNameFrom(input.boardName ?? null, input.translate);
  const parsed = /^([1-9]\d{0,18})$/.exec(input.ref);
  const replaceWords = await loadReplaceWords(input.sql);
  const page =
    parsed === null
      ? null
      : await buildConversationPage({
          sql: input.sql,
          memberId: input.session.memberId,
          locale: input.locale,
          translate: input.translate,
          conversationId: parsed[1] ?? "",
          attachmentsEnabled: flags.values.attachments === true,
          mentionsEnabled: flags.values.mentions === true,
          replaceWords,
        });

  if (page === null) {
    return notFoundPage(input, conversationContract);
  }

  const rendered = await renderCachedPage({
    tags: [`member:${input.session.memberId}`],
    cache: null,
    tagVersions: null,
    shell: { visitor: "member", authState: "authenticated" },
    prepare: async () => ({
      variant: pageVariant({
        route: conversationContract.route,
        params: { id: page.id },
        visibilityKey: "member",
        theme: null,
        pluginsGeneration: input.pluginsGeneration,
        locale: input.locale,
        colourScheme: input.colourScheme,
        renderFlagsHash: flags.hash,
      }),
      data: undefined,
    }),
    render: async () => {
      const themed = await renderThemedPage({
        sql: input.sql,
        boardName,
        locale: input.locale,
        translate: input.translate,
        template: "conversation",
        viewModel: { title: page.title, ...page.viewModel, flags: flags.values },
        breadcrumbs: page.breadcrumbs,
        route: conversationContract,
      });

      return { html: themed.html, errors: themed.errors };
    },
  });

  return {
    kind: "page",
    status: 200,
    html: rendered.html,
    title: page.title,
    boardName,
    errors: rendered.errors,
  };
}
