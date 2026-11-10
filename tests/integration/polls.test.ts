import { describe, expect, test } from "bun:test";
import {
  createRenderCache,
  createTagVersions,
  pollResultsTag,
  pollTag,
  readTagVersion,
} from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import {
  closePollTransitions,
  editPoll,
  type PollInput,
  pollResults,
  readPollForTopic,
  vote,
} from "@bulletin/domain/polls";
import { startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { pollResultsResponse } from "../../apps/user-api/src/polls.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderPollFragment } from "../../apps/user-app/src/polls/fragment.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "polls" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberSession(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
}

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

function poll(overrides: Partial<PollInput> = {}): PollInput {
  return {
    resultsVisibleBeforeVoting: false,
    closesAt: null,
    questions: [
      {
        prompt: "Which format?",
        multiple: false,
        choices: [{ label: "Novel" }, { label: "Short story" }],
      },
      {
        prompt: "Which themes?",
        multiple: true,
        choices: [{ label: "History" }, { label: "Science" }, { label: "Mystery" }],
      },
    ],
    ...overrides,
  };
}

async function createPollTopic(
  database: TestDatabase,
  input: PollInput,
  title = "Poll topic",
): Promise<{ topicId: string; postId: string; pollId: string }> {
  const member = await memberSession(database, "member-1");
  const offTopic = await forumId(database, "off-topic");
  const result = await startTopic(database.sql, {
    actorId: member.memberId,
    forumId: offTopic,
    title,
    bodyMd: "Poll body.",
    poll: input,
  });

  if (!result.ok) {
    throw new Error(`Could not create the poll topic: ${result.code}`);
  }

  const loaded = await readPollForTopic(database.sql, result.result.topicId);

  if (loaded === null) {
    throw new Error("Missing the created poll");
  }

  return { topicId: result.result.topicId, postId: result.result.postId, pollId: loaded.id };
}

function selectionsFor(pollRecord: NonNullable<Awaited<ReturnType<typeof readPollForTopic>>>) {
  return pollRecord.questions.map((question) => ({
    questionId: question.id,
    choiceIds: [question.choices[0]?.id ?? ""],
  }));
}

integrationDescribe("polls", () => {
  test("creates a multi-question poll and accepts exactly one vote", async () => {
    await withSeededDb(async (database) => {
      const created = await createPollTopic(database, poll(), "Multi question poll");
      const member = await memberSession(database, "member-1");
      const stored = await readPollForTopic(database.sql, created.topicId);

      expect(stored?.questions).toHaveLength(2);
      expect(stored?.questions[0]?.multiple).toBe(false);
      expect(stored?.questions[1]?.multiple).toBe(true);

      if (stored === null) {
        throw new Error("Missing poll");
      }

      const voted = await vote(database.sql, {
        actorId: member.memberId,
        pollId: created.pollId,
        selections: selectionsFor(stored),
      });
      expect(voted.ok).toBe(true);

      const second = await vote(database.sql, {
        actorId: member.memberId,
        pollId: created.pollId,
        selections: selectionsFor(stored),
      });
      expect(second).toEqual({ ok: false, code: "already_voted" });

      const results = await pollResults(database.sql, {
        pollId: created.pollId,
        actorId: member.memberId,
      });
      expect(results.ok).toBe(true);
      expect(results.ok ? results.result.totalVoters : 0).toBe(1);
      expect(results.ok ? results.result.questions[0]?.choices[0]?.votes : 0).toBe(1);
    });
  }, 30_000);

  test("a closed poll rejects votes and reveals results", async () => {
    await withSeededDb(async (database) => {
      const created = await createPollTopic(
        database,
        poll({ closesAt: new Date(Date.now() - 60_000) }),
        "Closed poll",
      );
      const member = await memberSession(database, "member-1");
      const stored = await readPollForTopic(database.sql, created.topicId);

      if (stored === null) {
        throw new Error("Missing poll");
      }

      expect(
        await vote(database.sql, {
          actorId: member.memberId,
          pollId: created.pollId,
          selections: selectionsFor(stored),
        }),
      ).toEqual({ ok: false, code: "closed" });

      const results = await pollResults(database.sql, {
        pollId: created.pollId,
        actorId: member.memberId,
      });
      expect(results.ok).toBe(true);
      expect(results.ok ? results.result.closed : false).toBe(true);
    });
  }, 30_000);

  test("hidden results stay out of shared HTML and the private endpoint checks each viewer", async () => {
    await withSeededDb(async (database) => {
      const created = await createPollTopic(database, poll(), "Hidden results poll");
      const voter = await memberSession(database, "member-1");
      const member = await memberSession(database, "member-2");
      const moderator = await memberSession(database, "super-mod");
      const stored = await readPollForTopic(database.sql, created.topicId);

      if (stored === null) {
        throw new Error("Missing poll");
      }

      await vote(database.sql, {
        actorId: voter.memberId,
        pollId: created.pollId,
        selections: selectionsFor(stored),
      });

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const guest = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${created.topicId}-hidden-results-poll`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });

        expect(guest.kind).toBe("page");
        const html = guest.kind === "page" ? guest.html : "";
        expect(html).toContain("data-poll-form");
        expect(html).not.toMatch(/data-poll-count="[^"]*">\s*\d+/);
        expect(html).not.toMatch(/data-poll-total>\s*\d+/);

        const guestResults = await pollResultsResponse(database.sql, null, created.pollId);
        expect(guestResults.status).toBe(401);

        const hidden = await pollResultsResponse(
          database.sql,
          { memberId: member.memberId },
          created.pollId,
        );
        expect(hidden.status).toBe(403);

        const voted = await pollResultsResponse(
          database.sql,
          { memberId: voter.memberId },
          created.pollId,
        );
        expect(voted.status).toBe(200);
        expect((await voted.json()) as { totalVoters: number }).toMatchObject({ totalVoters: 1 });

        const moderated = await pollResultsResponse(
          database.sql,
          { memberId: moderator.memberId },
          created.pollId,
        );
        expect(moderated.status).toBe(200);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("poll variants stay distinct and never carry hidden counts", async () => {
    await withSeededDb(async (database) => {
      const created = await createPollTopic(database, poll(), "Variant poll");
      const voter = await memberSession(database, "member-1");
      const member = await memberSession(database, "member-2");
      const moderator = await memberSession(database, "super-mod");
      const stored = await readPollForTopic(database.sql, created.topicId);

      if (stored === null) {
        throw new Error("Missing poll");
      }

      await vote(database.sql, {
        actorId: voter.memberId,
        pollId: created.pollId,
        selections: selectionsFor(stored),
      });

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = (session: UserAppSessionContext | null) => async () => {
          const result = await renderTopicRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session,
            ref: `${created.topicId}-variant-poll`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

          if (result.kind !== "page") {
            throw new Error("Expected a topic page");
          }

          return {
            variant: result.variant ?? "",
            html: result.html,
            ...(result.cache === null ? {} : { cache: result.cache }),
          };
        };
        const cases: VariantCase[] = [
          { name: "guest", render: render(null) },
          { name: "member", render: render(member) },
          { name: "moderator", render: render(moderator) },
        ];

        await assertCacheVariants({ route: "/topic/[ref]", cases, cache });
        const rendered = await Promise.all(cases.map((variantCase) => variantCase.render()));

        for (const page of rendered) {
          expect(page.html).not.toMatch(/data-poll-count="[^"]*">\s*\d+/);
        }
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("results require current read access and deny revoked voters", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");
      const staff = await forumId(database, "staff-room");
      const privateTopic = await startTopic(database.sql, {
        actorId: moderator.memberId,
        forumId: staff,
        title: "Private poll",
        bodyMd: "Body.",
        poll: poll(),
      });

      if (!privateTopic.ok) {
        throw new Error("Could not create the private poll");
      }

      const privatePoll = await readPollForTopic(database.sql, privateTopic.result.topicId);

      if (privatePoll === null) {
        throw new Error("Missing private poll");
      }

      expect(
        await pollResults(database.sql, {
          pollId: privatePoll.id,
          actorId: member.memberId,
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      const publicTopic = await createPollTopic(database, poll(), "Revoked voter poll");
      const publicPoll = await readPollForTopic(database.sql, publicTopic.topicId);

      if (publicPoll === null) {
        throw new Error("Missing public poll");
      }

      await vote(database.sql, {
        actorId: member.memberId,
        pollId: publicPoll.id,
        selections: selectionsFor(publicPoll),
      });
      expect(
        await pollResults(database.sql, {
          pollId: publicPoll.id,
          actorId: member.memberId,
        }),
      ).toMatchObject({ ok: true });

      await database.sql`
        UPDATE core.forum_permissions
        SET actions = 0
        WHERE mask_id = (SELECT id FROM core.masks WHERE key = 'standard')
          AND forum_id = (SELECT id FROM core.forums WHERE slug = 'community')
      `;
      expect(
        await pollResults(database.sql, {
          pollId: publicPoll.id,
          actorId: member.memberId,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
    });
  }, 30_000);

  test("poll fragments are cached per locale", async () => {
    await withSeededDb(async (database) => {
      const created = await createPollTopic(database, poll(), "Locale poll");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const labels: string[] = [];

        for (const locale of ["en", "es", "fr"] as const) {
          const translator = createServerT(locale, { shipped: USER_CATALOGS });
          const html = await renderPollFragment(
            database.sql,
            cache,
            created.pollId,
            locale,
            translator,
          );
          labels.push(html);
        }

        expect(labels[0]).toContain("Poll");
        expect(labels[1]).toContain("Encuesta");
        expect(labels[2]).toContain("Sondage");
        expect(new Set(labels).size).toBe(3);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("editing refuses to remove a voted choice unless a moderator confirms", async () => {
    await withSeededDb(async (database) => {
      const created = await createPollTopic(database, poll(), "Editable poll");
      const starter = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");
      const stored = await readPollForTopic(database.sql, created.topicId);

      if (stored === null) {
        throw new Error("Missing poll");
      }

      await vote(database.sql, {
        actorId: starter.memberId,
        pollId: created.pollId,
        selections: selectionsFor(stored),
      });

      const firstQuestion = stored.questions[0];
      const votedChoice = firstQuestion?.choices[0];

      if (firstQuestion === undefined || votedChoice === undefined) {
        throw new Error("Missing voted choice");
      }

      const edited = {
        ...poll(),
        questions: [
          {
            id: firstQuestion.id,
            prompt: firstQuestion.prompt,
            multiple: firstQuestion.multiple,
            choices: firstQuestion.choices
              .filter((choice) => choice.id !== votedChoice.id)
              .map((choice) => ({ id: choice.id, label: choice.label })),
          },
          ...(stored.questions[1] === undefined
            ? []
            : [
                {
                  id: stored.questions[1].id,
                  prompt: stored.questions[1].prompt,
                  multiple: stored.questions[1].multiple,
                  choices: stored.questions[1].choices.map((choice) => ({
                    id: choice.id,
                    label: choice.label,
                  })),
                },
              ]),
        ],
      } satisfies PollInput;

      expect(
        await editPoll(database.sql, {
          actorId: starter.memberId,
          pollId: created.pollId,
          poll: edited,
        }),
      ).toEqual({ ok: false, code: "voted_choice" });

      expect(
        await editPoll(database.sql, {
          actorId: moderator.memberId,
          pollId: created.pollId,
          poll: edited,
          confirmRemoveVoted: true,
        }),
      ).toMatchObject({ ok: true });

      const after = await readPollForTopic(database.sql, created.topicId);
      expect(after?.questions[0]?.choices.map((choice) => choice.id)).not.toContain(votedChoice.id);
    });
  }, 30_000);

  test("editing outside the starter's window is rejected", async () => {
    await withSeededDb(async (database) => {
      const created = await createPollTopic(database, poll(), "Old poll");
      const starter = await memberSession(database, "member-1");

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'posting.edit_window_minutes', to_jsonb(60)
        FROM core.groups WHERE key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      await database.sql`
        UPDATE core.polls SET created_at = now() - interval '2 hours' WHERE id = ${created.pollId}
      `;

      expect(
        await editPoll(database.sql, {
          actorId: starter.memberId,
          pollId: created.pollId,
          poll: poll(),
        }),
      ).toEqual({ ok: false, code: "edit_window_expired" });
    });
  }, 30_000);

  test("the poll fragment caps its TTL at the close time and shows results afterwards", async () => {
    await withSeededDb(async (database) => {
      let now = new Date("2026-11-10T12:00:00Z");
      const created = await createPollTopic(
        database,
        poll({ closesAt: new Date(now.getTime() + 1_000) }),
        "Transition poll",
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions, now: () => now.getTime() });
        const open = await renderPollFragment(
          database.sql,
          cache,
          created.pollId,
          "en",
          translate,
          now,
        );
        expect(open).toContain("data-poll-form");
        expect(open).toContain("data-poll-results hidden");

        now = new Date(now.getTime() + 2_000);
        const closed = await renderPollFragment(
          database.sql,
          cache,
          created.pollId,
          "en",
          translate,
          now,
        );
        expect(closed).not.toContain("data-poll-form");
        expect(closed).toContain('data-poll-closed="true"');
        expect(closed).not.toContain("data-poll-results hidden");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("the minute transition bumps both poll tags", async () => {
    await withSeededDb(async (database) => {
      const closedAt = new Date(Date.now() - 1_000);
      const created = await createPollTopic(database, poll({ closesAt: closedAt }), "Tag poll");

      expect(await closePollTransitions(database.sql, new Date())).toBeGreaterThanOrEqual(1);
      expect(await readTagVersion(database.sql, pollTag(created.pollId))).toBe("1");
      expect(await readTagVersion(database.sql, pollResultsTag(created.pollId))).toBe("1");
    });
  }, 30_000);

  test("rejects a poll with too few choices at creation", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const offTopic = await forumId(database, "off-topic");
      const result = await startTopic(database.sql, {
        actorId: member.memberId,
        forumId: offTopic,
        title: "Bad poll",
        bodyMd: "Body.",
        poll: {
          resultsVisibleBeforeVoting: false,
          closesAt: null,
          questions: [{ prompt: "Only one?", multiple: false, choices: [{ label: "One" }] }],
        },
      });
      expect(result).toEqual({ ok: false, code: "invalid_poll" });
    });
  }, 30_000);
});
