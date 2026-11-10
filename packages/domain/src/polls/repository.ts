import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import { loadMergedGroupSettings } from "../permissions/store.ts";
import { loadForumTree } from "../permissions/tree-store.ts";

export interface PollChoiceInput {
  readonly id?: string;
  readonly label: string;
}

export interface PollQuestionInput {
  readonly id?: string;
  readonly prompt: string;
  readonly multiple: boolean;
  readonly choices: readonly PollChoiceInput[];
}

export interface PollInput {
  readonly resultsVisibleBeforeVoting: boolean;
  readonly closesAt: Date | null;
  readonly questions: readonly PollQuestionInput[];
}

export interface PollChoiceRecord {
  readonly id: string;
  readonly label: string;
  readonly position: number;
  readonly votes: number;
}

export interface PollQuestionRecord {
  readonly id: string;
  readonly prompt: string;
  readonly multiple: boolean;
  readonly position: number;
  readonly choices: readonly PollChoiceRecord[];
}

export interface PollRecord {
  readonly id: string;
  readonly topicId: string;
  readonly forumId: string;
  readonly starterId: string | null;
  readonly resultsVisibleBeforeVoting: boolean;
  readonly closesAt: Date | null;
  readonly createdAt: Date;
  readonly totalVoters: number;
  readonly questions: readonly PollQuestionRecord[];
}

interface PollRow {
  readonly id: string;
  readonly topic_id: string;
  readonly forum_id: string;
  readonly starter_id: string | null;
  readonly results_visible_before_voting: boolean;
  readonly closes_at: Date | null;
  readonly created_at: Date;
  readonly total_voters: number;
}

interface QuestionRow {
  readonly id: string;
  readonly position: number;
  readonly prompt: string;
  readonly multiple: boolean;
  readonly choice_id: string | null;
  readonly choice_position: number | null;
  readonly choice_label: string | null;
  readonly choice_votes: number | null;
}

function pollRecord(row: PollRow, questions: readonly PollQuestionRecord[]): PollRecord {
  return {
    id: row.id,
    topicId: row.topic_id,
    forumId: row.forum_id,
    starterId: row.starter_id,
    resultsVisibleBeforeVoting: row.results_visible_before_voting,
    closesAt: row.closes_at,
    createdAt: row.created_at,
    totalVoters: row.total_voters,
    questions,
  };
}

function questionRecords(rows: readonly QuestionRow[]): readonly PollQuestionRecord[] {
  const byQuestion = new Map<string, { row: QuestionRow; choices: PollChoiceRecord[] }>();

  for (const row of rows) {
    const entry = byQuestion.get(row.id) ?? { row, choices: [] };

    if (row.choice_id !== null && row.choice_label !== null) {
      entry.choices.push({
        id: row.choice_id,
        label: row.choice_label,
        position: row.choice_position ?? 0,
        votes: row.choice_votes ?? 0,
      });
    }

    byQuestion.set(row.id, entry);
  }

  return [...byQuestion.values()].map(({ row, choices }) => ({
    id: row.id,
    prompt: row.prompt,
    multiple: row.multiple,
    position: row.position,
    choices,
  }));
}

const QUESTION_SQL = (sql: SQL, pollId: string) => sql`
  SELECT
    q.id, q.position, q.prompt, q.multiple,
    c.id AS choice_id, c.position AS choice_position, c.label AS choice_label,
    (
      SELECT count(*)::int FROM core.poll_vote_choices vc WHERE vc.choice_id = c.id
    ) AS choice_votes
  FROM core.poll_questions q
  LEFT JOIN core.poll_choices c ON c.question_id = q.id AND c.poll_id = q.poll_id
  WHERE q.poll_id = ${pollId}
  ORDER BY q.position, q.id, c.position, c.id
`;

export async function readPoll(sql: SQL, pollId: string): Promise<PollRecord | null> {
  if (!/^\d+$/.test(pollId)) {
    return null;
  }

  const [row] = (await sql`
    SELECT
      p.id, p.topic_id, t.forum_id, t.starter_id, p.results_visible_before_voting,
      p.closes_at, p.created_at,
      (SELECT count(*)::int FROM core.poll_votes v WHERE v.poll_id = p.id) AS total_voters
    FROM core.polls p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ${pollId}
  `) as PollRow[];

  if (row === undefined) {
    return null;
  }

  return pollRecord(row, questionRecords((await QUESTION_SQL(sql, pollId)) as QuestionRow[]));
}

export async function readPollForTopic(sql: SQL, topicId: string): Promise<PollRecord | null> {
  const [row] = (await sql`
    SELECT
      p.id, p.topic_id, t.forum_id, t.starter_id, p.results_visible_before_voting,
      p.closes_at, p.created_at,
      (SELECT count(*)::int FROM core.poll_votes v WHERE v.poll_id = p.id) AS total_voters
    FROM core.polls p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.topic_id = ${topicId}
  `) as PollRow[];

  if (row === undefined) {
    return null;
  }

  return pollRecord(row, questionRecords((await QUESTION_SQL(sql, row.id)) as QuestionRow[]));
}

export async function insertPoll(tx: SQL, topicId: string, input: PollInput): Promise<string> {
  const [poll] = (await tx`
    INSERT INTO core.polls (topic_id, results_visible_before_voting, closes_at)
    VALUES (${topicId}, ${input.resultsVisibleBeforeVoting}, ${input.closesAt})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const pollId = poll?.id;

  if (pollId === undefined) {
    throw new Error("Could not insert the poll");
  }

  for (const [questionIndex, question] of input.questions.entries()) {
    const [row] = (await tx`
      INSERT INTO core.poll_questions (poll_id, position, prompt, multiple)
      VALUES (${pollId}, ${questionIndex}, ${question.prompt}, ${question.multiple})
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    const questionId = row?.id;

    if (questionId === undefined) {
      throw new Error("Could not insert the poll question");
    }

    for (const [choiceIndex, choice] of question.choices.entries()) {
      await tx`
        INSERT INTO core.poll_choices (poll_id, question_id, position, label)
        VALUES (${pollId}, ${questionId}, ${choiceIndex}, ${choice.label})
      `;
    }
  }

  return pollId;
}

export interface VoteSelection {
  readonly questionId: string;
  readonly choiceIds: readonly string[];
}

export interface PollVoteRecord {
  readonly pollId: string;
  readonly memberId: string;
  readonly createdAt: Date;
}

export async function readPollVote(
  sql: SQL,
  pollId: string,
  memberId: string,
): Promise<PollVoteRecord | null> {
  const [row] = (await sql`
    SELECT poll_id, member_id, created_at
    FROM core.poll_votes
    WHERE poll_id = ${pollId} AND member_id = ${memberId}
  `) as Array<{ poll_id: string; member_id: string; created_at: Date }>;

  return row === undefined
    ? null
    : { pollId: row.poll_id, memberId: row.member_id, createdAt: row.created_at };
}

export async function canVoteInPoll(sql: SQL, memberId: string, forumId: string): Promise<boolean> {
  const tree = await loadForumTree(sql);

  return can(sql, memberId, "vote", { forumId, tree });
}

export async function canModeratePoll(
  sql: SQL,
  memberId: string,
  forumId: string,
): Promise<boolean> {
  const tree = await loadForumTree(sql);
  return can(sql, memberId, "edit", { forumId, tree });
}

export async function pollEditWindowMinutes(sql: SQL, memberId: string): Promise<number> {
  const settings = await loadMergedGroupSettings(sql, memberId);
  const value = settings["posting.edit_window_minutes"];

  return typeof value === "number" ? value : 0;
}

export async function insertPollVote(
  tx: SQL,
  pollId: string,
  memberId: string,
  selections: readonly VoteSelection[],
): Promise<void> {
  await tx`
    INSERT INTO core.poll_votes (poll_id, member_id)
    VALUES (${pollId}, ${memberId})
  `;

  for (const selection of selections) {
    for (const choiceId of selection.choiceIds) {
      await tx`
        INSERT INTO core.poll_vote_choices (poll_id, member_id, question_id, choice_id)
        VALUES (${pollId}, ${memberId}, ${selection.questionId}, ${choiceId})
      `;
    }
  }
}

/** Poll vote state for the personal overlay; never part of shared HTML. */
export async function pollVoteStateForTopic(
  sql: SQL,
  topicId: string,
  memberId: string,
): Promise<{ readonly pollId: string; readonly hasVoted: boolean } | null> {
  const [poll] = (await sql`
    SELECT p.id::text AS id
    FROM core.polls p
    WHERE p.topic_id = ${topicId}
  `) as Array<{ id: string }>;

  if (poll === undefined) {
    return null;
  }

  const [vote] = (await sql`
    SELECT 1 FROM core.poll_votes WHERE poll_id = ${poll.id} AND member_id = ${memberId}
  `) as unknown[];

  return { pollId: poll.id, hasVoted: vote !== undefined };
}

export interface PollReplacementChoice {
  readonly id?: string;
  readonly label: string;
}

export interface PollReplacementQuestion {
  readonly id?: string;
  readonly prompt: string;
  readonly multiple: boolean;
  readonly choices: readonly PollReplacementChoice[];
}

export async function replacePoll(
  tx: SQL,
  poll: PollRecord,
  input: {
    readonly resultsVisibleBeforeVoting: boolean;
    readonly closesAt: Date | null;
    readonly questions: readonly PollReplacementQuestion[];
    readonly allowVotedChoiceRemoval: boolean;
  },
): Promise<void> {
  const existingVotes = new Map<string, number>();

  for (const question of poll.questions) {
    for (const choice of question.choices) {
      existingVotes.set(choice.id, choice.votes);
    }
  }

  const keptChoiceIds = new Set(
    input.questions.flatMap((question) =>
      question.choices.flatMap((choice) => (choice.id === undefined ? [] : [choice.id])),
    ),
  );

  for (const [choiceId, votes] of existingVotes) {
    if (!keptChoiceIds.has(choiceId) && votes > 0 && !input.allowVotedChoiceRemoval) {
      throw new Error("voted_choice");
    }
  }

  await tx`
    UPDATE core.polls
    SET results_visible_before_voting = ${input.resultsVisibleBeforeVoting},
        closes_at = ${input.closesAt},
        updated_at = now()
    WHERE id = ${poll.id}
  `;

  const keptQuestionIds = new Set(
    input.questions.flatMap((question) => (question.id === undefined ? [] : [question.id])),
  );

  for (const question of poll.questions) {
    if (!keptQuestionIds.has(question.id)) {
      await tx`DELETE FROM core.poll_questions WHERE id = ${question.id}`;
    }
  }

  for (const [questionIndex, question] of input.questions.entries()) {
    let questionId = question.id;

    if (questionId === undefined) {
      const [row] = (await tx`
        INSERT INTO core.poll_questions (poll_id, position, prompt, multiple)
        VALUES (${poll.id}, ${questionIndex}, ${question.prompt}, ${question.multiple})
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      questionId = row?.id;

      if (questionId === undefined) {
        throw new Error("Could not insert the poll question");
      }
    } else {
      await tx`
        UPDATE core.poll_questions
        SET position = ${questionIndex}, prompt = ${question.prompt}, multiple = ${question.multiple}
        WHERE id = ${questionId} AND poll_id = ${poll.id}
      `;
    }

    const questionRecord = poll.questions.find((candidate) => candidate.id === questionId);
    const keptChoices = new Set(
      question.choices.flatMap((choice) => (choice.id === undefined ? [] : [choice.id])),
    );

    for (const choice of questionRecord?.choices ?? []) {
      if (!keptChoices.has(choice.id)) {
        await tx`DELETE FROM core.poll_choices WHERE id = ${choice.id} AND poll_id = ${poll.id}`;
      }
    }

    for (const [choiceIndex, choice] of question.choices.entries()) {
      if (choice.id === undefined) {
        await tx`
          INSERT INTO core.poll_choices (poll_id, question_id, position, label)
          VALUES (${poll.id}, ${questionId}, ${choiceIndex}, ${choice.label})
        `;
      } else {
        await tx`
          UPDATE core.poll_choices
          SET position = ${choiceIndex}, label = ${choice.label}
          WHERE id = ${choice.id} AND poll_id = ${poll.id} AND question_id = ${questionId}
        `;
      }
    }
  }
}

/** Polls whose close time passed in the last 90 s; the minute worker bumps their fragments. */
export async function recentlyClosedPollIds(sql: SQL, now: Date): Promise<readonly string[]> {
  const since = new Date(now.getTime() - 90_000);
  const rows = (await sql`
    SELECT id::text AS id
    FROM core.polls
    WHERE closes_at IS NOT NULL
      AND closes_at > ${since}
      AND closes_at <= ${now}
    ORDER BY id
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}
