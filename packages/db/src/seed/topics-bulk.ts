import { type RenderResult, renderContent } from "@bulletin/content";
import {
  createMentionResolver,
  insertQuoteSnapshot,
  listEmbedProviders,
  listRenderEmoticons,
} from "@bulletin/domain/content";
import { slugify } from "@bulletin/domain/urls";
import type { SQL } from "bun";
import type { SeedContext } from "./framework.ts";

interface ForumSeedRow {
  readonly id: string;
  readonly slug: string;
  readonly language: string | null;
}

type Locale = "en" | "es" | "fr";

const TITLES: Readonly<Record<Locale, readonly string[]>> = {
  en: [
    "What are you working on today?",
    "Share your favourite small win",
    "A question about the new editor",
    "Weekend reading recommendations",
    "How do you organise your bookmarks?",
    "Tips for a calmer notification inbox",
    "Show us your favourite corner of the web",
    "What made you smile this week?",
    "A beginner asks about quoting",
    "Community project ideas",
  ],
  es: [
    "¿En qué estás trabajando hoy?",
    "Comparte una pequeña victoria",
    "Una pregunta sobre el nuevo editor",
    "Recomendaciones de lectura",
    "¿Cómo organizas tus marcadores?",
    "Consejos para una bandeja tranquila",
    "¿Qué te hizo sonreír esta semana?",
    "Ideas para un proyecto comunitario",
  ],
  fr: [
    "Sur quoi travaillez-vous aujourd’hui ?",
    "Partagez une petite victoire",
    "Une question sur le nouvel éditeur",
    "Vos lectures du week-end",
    "Comment organisez-vous vos favoris ?",
    "Des conseils pour une boîte calme",
    "Qu’est-ce qui vous a fait sourire ?",
    "Des idées de projet communautaire",
  ],
};

const BODIES: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en: {
    plain:
      "I have been thinking about this for a while.\n\nThere are a few small things that made a real difference: writing things down, keeping the important links close, and asking for help early.\n\nWhat works for you?",
    mention:
      "Thanks {{mention}} for the pointer earlier.\n\nI tried it on my phone and the result was much clearer than I expected.",
    code: "Here is the tiny script I use to tidy a folder:\n\n```ts\nconst files = await Array.fromAsync(new Bun.Glob('*.md').scan('.'));\nconsole.log(files.sort());\n```\n\nIt is not clever, but it saves me a few minutes every week.",
    embed:
      "This talk is a good introduction to the topic:\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\nI would be interested in what others think of the second half.",
    edited:
      "An updated version of my earlier note.\n\nAfter trying the suggestions in this topic I changed my routine: fewer open tabs, one clear checklist, and a short walk before the hard part.\n\nThanks to everyone who replied.",
  },
  es: {
    plain:
      "Llevo un tiempo pensando en esto.\n\nHay tres cosas pequeñas que me ayudaron: escribir las ideas, tener los enlaces importantes a mano y pedir ayuda pronto.\n\n¿A vosotros qué os funciona?",
    mention:
      "Gracias {{mention}} por la pista.\n\nLo probé en el móvil y el resultado fue mucho más claro de lo que esperaba.",
    code: "Este es el pequeño script que uso para ordenar una carpeta:\n\n```ts\nconst files = await Array.fromAsync(new Bun.Glob('*.md').scan('.'));\nconsole.log(files.sort());\n```",
    embed:
      "Esta charla es una buena introducción:\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\nMe interesa la segunda mitad.",
    edited:
      "Una versión actualizada de mi nota.\n\nDespués de probar las sugerencias cambié la rutina: menos pestañas, una lista clara y un paseo corto antes de empezar.",
  },
  fr: {
    plain:
      "J’y pense depuis un moment.\n\nTrois petites choses m’ont aidé : écrire les idées, garder les liens importants à portée de main et demander de l’aide assez tôt.\n\nEt vous, qu’est-ce qui marche ?",
    mention:
      "Merci {{mention}} pour l’indication.\n\nJ’ai essayé sur mon téléphone et le résultat était bien plus clair que prévu.",
    code: "Voici le petit script que j’utilise pour ranger un dossier :\n\n```ts\nconst files = await Array.fromAsync(new Bun.Glob('*.md').scan('.'));\nconsole.log(files.sort());\n```",
    embed:
      "Cette conférence est une bonne introduction :\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\nLa seconde partie m’intéresse particulièrement.",
    edited:
      "Une version mise à jour de ma note.\n\nAprès avoir essayé les suggestions, j’ai changé ma routine : moins d’onglets, une liste claire et une courte marche avant de commencer.",
  },
};

function localeFor(index: number, forum: ForumSeedRow): Locale {
  if (forum.language === "en") {
    return "en";
  }

  if (index % 13 === 0) {
    return "fr";
  }

  return index % 11 === 0 ? "es" : "en";
}

function titleFor(locale: Locale, index: number): string {
  const titles = TITLES[locale];
  const title = titles[index % titles.length] ?? titles[0] ?? "Community topic";
  return `${title} ${Math.floor(index / titles.length) + 1}`;
}

interface RenderVariants {
  readonly plain: RenderResult;
  readonly mention: RenderResult;
  readonly code: RenderResult;
  readonly embed: RenderResult;
  readonly edited: RenderResult;
}

async function renderVariants(
  locale: Locale,
  authorId: string,
  emoticons: Awaited<ReturnType<typeof listRenderEmoticons>>,
  mentions: ReturnType<typeof createMentionResolver>,
  embeds: Awaited<ReturnType<typeof listEmbedProviders>>,
  mentionToken: string,
): Promise<RenderVariants> {
  const bodies = BODIES[locale];
  const render = (body: string) =>
    renderContent(body, {
      profile: "post",
      context: { kind: "forum_post", forumId: "1" },
      authorId,
      emoticons,
      mentions,
      embeds,
    });

  return {
    plain: await render(bodies.plain ?? ""),
    mention: await render((bodies.mention ?? "").replace("{{mention}}", mentionToken)),
    code: await render(bodies.code ?? ""),
    embed: await render(bodies.embed ?? ""),
    edited: await render(bodies.edited ?? ""),
  };
}

async function renderQuote(
  sql: SQL,
  sourcePostId: string,
  authorId: string,
  forumId: string,
  emoticons: Awaited<ReturnType<typeof listRenderEmoticons>>,
  mentions: ReturnType<typeof createMentionResolver>,
  embeds: Awaited<ReturnType<typeof listEmbedProviders>>,
): Promise<RenderResult> {
  return renderContent(
    `:::quote{source="post:${sourcePostId}"}\n:::\n\nThat is a useful way to look at it. I will try the same approach this week.`,
    {
      profile: "post",
      context: { kind: "forum_post", forumId },
      authorId,
      emoticons,
      mentions,
      embeds,
      quotes: {
        resolver: {
          canRead: async () => true,
          async load(ref) {
            const [row] = (await sql`
              SELECT
                p.id::text AS id, p.author_id::text AS author_id, p.body_md,
                t.forum_id::text AS forum_id
              FROM core.posts p
              JOIN core.topics t ON t.id = p.topic_id
              WHERE p.id = ${ref.id}
            `) as Array<{
              id: string;
              author_id: string | null;
              body_md: string;
              forum_id: string;
            }>;

            return row === undefined
              ? null
              : {
                  ref: { kind: "post", id: row.id },
                  sourceAuthorId: row.author_id,
                  bodyMd: row.body_md,
                  contextId: row.forum_id,
                };
          },
        },
        snapshots: {
          create: (draft) => insertQuoteSnapshot(sql, draft),
        },
      },
    },
  );
}

interface BulkTopic {
  readonly topicId: string;
  readonly forumId: string;
  readonly forumSlug: string;
  readonly title: string;
  readonly slug: string;
  readonly starterId: string;
}

export async function seedBulkTopics(
  context: SeedContext,
  members: ReadonlyMap<string, string>,
  forums: ReadonlyMap<string, string>,
): Promise<void> {
  const { sql, rng, size } = context;
  const total = size === "small" ? 140 : size === "large" ? 2_600 : 1_000;
  const forumRows = (await sql`
    SELECT id::text AS id, slug, language
    FROM core.forums
    WHERE type = 'forum'
    ORDER BY id
  `) as ForumSeedRow[];

  if (forumRows.length === 0) {
    return;
  }

  const authorSubs = [
    "member-1",
    "member-2",
    "member-es",
    "member-fr",
    "new-member",
    "warned-member",
    "account-member",
    "regular-member-one",
  ].filter((sub) => members.has(sub));
  const staffSubs = ["super-mod", "admin", "member-mod", "forum-mod"].filter((sub) =>
    members.has(sub),
  );
  const memberIds = [...members.values()];
  const firstAuthor = members.get("member-1") ?? memberIds[0];
  const mentionId = members.get("member-1");
  const mentionToken =
    mentionId === undefined ? "a regular member" : `@[Regular Member One](member:${mentionId})`;

  if (firstAuthor === undefined) {
    return;
  }

  const [emoticons, mentions, embeds] = await Promise.all([
    listRenderEmoticons(sql),
    Promise.resolve(createMentionResolver(sql)),
    listEmbedProviders(sql),
  ]);
  const variants = new Map<Locale, RenderVariants>();

  for (const locale of ["en", "es", "fr"] as const) {
    variants.set(
      locale,
      await renderVariants(locale, firstAuthor, emoticons, mentions, embeds, mentionToken),
    );
  }

  const now = Date.now();
  const created: BulkTopic[] = [];

  for (let index = 0; index < total; index += 1) {
    const forum = forumRows[index % forumRows.length];

    if (forum === undefined) {
      continue;
    }

    const staffForum = forum.slug === "staff-room" || forum.slug === "moderation-notes";
    const authors = staffForum && staffSubs.length > 0 ? staffSubs : authorSubs;
    const locale = staffForum ? "en" : localeFor(index, forum);
    const title = titleFor(locale, index);
    const starterSub = authors[Math.floor(rng() * authors.length)] ?? "member-1";
    const starterId = members.get(starterSub);

    if (starterId === undefined) {
      continue;
    }

    const topicVariants = variants.get(locale);

    if (topicVariants === undefined) {
      continue;
    }

    const createdAt = new Date(
      now - Math.floor(((total - index) / total) * 400 * 24 * 60 * 60 * 1_000) - rng() * 3_600_000,
    );
    const slug = `${slugify(title)}-${index + 1}`;
    const pinned = index % 83 === 0;
    const locked = index % 67 === 0;
    const [topic] = (await sql`
      INSERT INTO core.topics (
        forum_id, title, slug, starter_id, pinned, locked, created_at, updated_at
      )
      VALUES (
        ${forum.id}, ${title}, ${slug}, ${starterId}, ${pinned}, ${locked},
        ${createdAt}, ${createdAt}
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (topic === undefined) {
      continue;
    }

    created.push({
      topicId: topic.id,
      forumId: forum.id,
      forumSlug: forum.slug,
      title,
      slug,
      starterId,
    });

    const replyCount = index % 97 === 0 ? 16 : Math.floor(rng() * 7);
    let previousPostId: string | null = null;

    for (let position = 0; position < replyCount + 1; position += 1) {
      const authorSub = authors[Math.floor(rng() * authors.length)] ?? starterSub;
      const authorId = members.get(authorSub) ?? starterId;
      const kind =
        position === 1 && index % 7 === 0
          ? "quote"
          : position === 1 && index % 11 === 0
            ? "mention"
            : position === 1 && index % 13 === 0
              ? "code"
              : position === 1 && index % 17 === 0
                ? "embed"
                : "plain";
      const original =
        kind === "quote" && previousPostId !== null
          ? await renderQuote(sql, previousPostId, authorId, forum.id, emoticons, mentions, embeds)
          : kind === "mention"
            ? topicVariants.mention
            : kind === "code"
              ? topicVariants.code
              : kind === "embed"
                ? topicVariants.embed
                : topicVariants.plain;
      const edited = position === 1 && index % 9 === 0 && kind !== "quote";
      const rendering = edited ? topicVariants.edited : original;
      const visibility = position > 0 && (index + position) % 29 === 0 ? "soft_deleted" : "visible";
      const postedAt = new Date(createdAt.getTime() + position * (4 + rng() * 20) * 60_000);
      const editedAt = edited ? new Date(postedAt.getTime() + 45 * 60_000) : null;
      const [row] = (await sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version,
          sanitiser_version, position, visibility, created_at, edited_at, edited_by
        )
        VALUES (
          ${topic.id}, ${authorId}, ${rendering.bodyMd}, ${rendering.bodyHtml},
          ${rendering.bodyText}, ${rendering.renderVersion}, ${rendering.sanitiserVersion},
          ${position + 1}, ${visibility}, ${postedAt}, ${editedAt},
          ${edited ? authorId : null}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (row === undefined) {
        continue;
      }

      if (edited && editedAt !== null) {
        await sql`
          INSERT INTO core.post_revisions (
            post_id, body_md, body_html, body_text, render_version, sanitiser_version,
            editor_id, edited_at
          )
          VALUES (
            ${row.id}, ${original.bodyMd}, ${original.bodyHtml}, ${original.bodyText},
            ${original.renderVersion}, ${original.sanitiserVersion}, ${authorId}, ${postedAt}
          )
        `;
      }

      previousPostId = row.id;
    }

    if (index % 70 === 0) {
      await seedPoll(sql, topic.id, index, memberIds, locale);
    }
  }

  const destination = forums.get("resolved-topics") ?? forums.get("archived-announcements");
  const sourceTopics = created
    .filter((topic) => topic.forumSlug === "general-discussion")
    .slice(0, 4);

  if (destination !== undefined) {
    for (const topic of sourceTopics) {
      await sql`UPDATE core.topics SET forum_id = ${destination} WHERE id = ${topic.topicId}`;
      await sql`
        INSERT INTO core.topics (
          forum_id, title, slug, starter_id, locked, moved_to, stub_expires_at, last_post_at
        )
        VALUES (
          ${topic.forumId}, ${topic.title}, ${topic.slug}, ${topic.starterId}, true,
          ${topic.topicId}, ${new Date(now + 7 * 24 * 60 * 60 * 1_000)}, ${new Date(now)}
        )
      `;
    }
  }

  await reconcileCounters(sql);

  for (const [offset, sub] of ["member-1", "member-2"].entries()) {
    const readerId = members.get(sub);

    if (readerId === undefined) {
      continue;
    }

    await sql`
      INSERT INTO core.topic_reads (member_id, topic_id, last_read_at, last_read_post_id)
      SELECT
        ${readerId},
        t.id,
        CASE WHEN t.id % 7 = 0 THEN t.last_post_at ELSE t.last_post_at - interval '2 days' END,
        CASE WHEN t.id % 7 = 0 THEN t.last_post_id ELSE t.first_post_id END
      FROM core.topics t
      WHERE t.moved_to IS NULL
        AND t.last_post_id IS NOT NULL
        AND t.id % ${5 + offset} = 0
      ON CONFLICT (member_id, topic_id) DO UPDATE
        SET last_read_at = EXCLUDED.last_read_at,
            last_read_post_id = EXCLUDED.last_read_post_id
    `;
  }

  const announcements = forums.get("announcements");
  const secondReader = members.get("member-2");

  if (announcements !== undefined && secondReader !== undefined) {
    await sql`
      INSERT INTO core.forum_reads (member_id, forum_id, marked_at)
      VALUES (${secondReader}, ${announcements}, now() - interval '30 days')
      ON CONFLICT (member_id, forum_id) DO NOTHING
    `;
  }
}

async function seedPoll(
  sql: SQL,
  topicId: string,
  index: number,
  memberIds: readonly string[],
  locale: Locale,
): Promise<void> {
  const prompt =
    locale === "es"
      ? "¿Qué opción prefieres?"
      : locale === "fr"
        ? "Quelle option préférez-vous ?"
        : "Which option do you prefer?";
  const choices =
    locale === "es"
      ? ["La primera", "La segunda", "La tercera"]
      : locale === "fr"
        ? ["La première", "La deuxième", "La troisième"]
        : ["The first", "The second", "The third"];
  const [poll] = (await sql`
    INSERT INTO core.polls (topic_id, results_visible_before_voting)
    VALUES (${topicId}, ${index % 140 === 0})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (poll === undefined) {
    return;
  }

  const [question] = (await sql`
    INSERT INTO core.poll_questions (poll_id, position, prompt, multiple)
    VALUES (${poll.id}, 0, ${prompt}, false)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (question === undefined) {
    return;
  }

  const choiceIds: string[] = [];

  for (const [position, label] of choices.entries()) {
    const [choice] = (await sql`
      INSERT INTO core.poll_choices (poll_id, question_id, position, label)
      VALUES (${poll.id}, ${question.id}, ${position}, ${label})
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (choice !== undefined) {
      choiceIds.push(choice.id);
    }
  }

  const voteCount = Math.min(choiceIds.length + 2, memberIds.length);

  for (let indexVote = 0; indexVote < voteCount; indexVote += 1) {
    const memberId = memberIds[(index + indexVote) % memberIds.length];
    const choiceId = choiceIds[indexVote % choiceIds.length];

    if (memberId === undefined || choiceId === undefined) {
      continue;
    }

    const [vote] = (await sql`
      INSERT INTO core.poll_votes (poll_id, member_id)
      VALUES (${poll.id}, ${memberId})
      ON CONFLICT (poll_id, member_id) DO NOTHING
      RETURNING 1 AS ok
    `) as Array<{ ok: number }>;

    if (vote === undefined) {
      continue;
    }

    await sql`
      INSERT INTO core.poll_vote_choices (poll_id, member_id, question_id, choice_id)
      VALUES (${poll.id}, ${memberId}, ${question.id}, ${choiceId})
      ON CONFLICT DO NOTHING
    `;
  }
}

async function reconcileCounters(sql: SQL): Promise<void> {
  await sql`
    UPDATE core.topics t
    SET reply_count = GREATEST((
          SELECT count(*) - 1 FROM core.posts p
          WHERE p.topic_id = t.id AND p.visibility = 'visible'
        ), 0),
        first_post_id = (
          SELECT id FROM core.posts p
          WHERE p.topic_id = t.id AND p.visibility = 'visible'
          ORDER BY position LIMIT 1
        ),
        last_post_id = (
          SELECT id FROM core.posts p
          WHERE p.topic_id = t.id AND p.visibility = 'visible'
          ORDER BY position DESC LIMIT 1
        ),
        last_post_at = (
          SELECT created_at FROM core.posts p
          WHERE p.topic_id = t.id AND p.visibility = 'visible'
          ORDER BY position DESC LIMIT 1
        )
  `;
  await sql`
    UPDATE core.forums f
    SET topic_count = (
          SELECT count(*)::int FROM core.topics t
          WHERE t.forum_id = f.id AND t.moved_to IS NULL
        ),
        post_count = (
          SELECT count(*)::int
          FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = f.id AND p.visibility = 'visible'
        ),
        last_topic_id = (
          SELECT t.id FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = f.id AND p.visibility = 'visible'
          ORDER BY p.created_at DESC, p.id DESC LIMIT 1
        ),
        last_post_id = (
          SELECT p.id FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = f.id AND p.visibility = 'visible'
          ORDER BY p.created_at DESC, p.id DESC LIMIT 1
        ),
        last_post_member_id = (
          SELECT p.author_id FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = f.id AND p.visibility = 'visible'
          ORDER BY p.created_at DESC, p.id DESC LIMIT 1
        ),
        last_post_at = (
          SELECT p.created_at FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = f.id AND p.visibility = 'visible'
          ORDER BY p.created_at DESC, p.id DESC LIMIT 1
        )
  `;
  await sql`
    UPDATE core.members m
    SET post_count = (
      SELECT count(*)::int FROM core.posts p
      WHERE p.author_id = m.id AND p.visibility = 'visible'
    )
  `;
}
