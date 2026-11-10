import { bumpCacheTags, pollResultsTag, pollTag } from "@bulletin/cache";
import type { SQL } from "bun";
import { runMutation } from "../mutations/index.ts";
import { pollEditMutation, pollVoteMutation } from "../mutations/polls.ts";
import {
  canModeratePoll,
  canReadPoll,
  canVoteInPoll,
  insertPollVote,
  type PollInput,
  type PollQuestionRecord,
  type PollRecord,
  pollEditWindowMinutes,
  readPoll,
  readPollVote,
  recentlyClosedPollIds,
  replacePoll,
  type VoteSelection,
} from "./repository.ts";

export * from "./repository.ts";

export type PollErrorCode =
  | "not_found"
  | "forbidden"
  | "closed"
  | "already_voted"
  | "invalid_choice"
  | "invalid_poll"
  | "edit_window_expired"
  | "voted_choice";

export type PollOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly code: PollErrorCode };

class PollRejected extends Error {
  readonly code: PollErrorCode;

  constructor(code: PollErrorCode) {
    super(`Poll rejected: ${code}`);
    this.name = "PollRejected";
    this.code = code;
  }
}

function reject(code: PollErrorCode): never {
  throw new PollRejected(code);
}

function rejected(error: unknown): PollOutcome<never> | null {
  return error instanceof PollRejected ? { ok: false, code: error.code } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

function optionalId(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

/** Structural validation for callers that already built a `PollInput`. */
export function validPollInput(input: PollInput): boolean {
  if (input.questions.length < 1 || input.questions.length > 10) {
    return false;
  }

  if (input.closesAt !== null && Number.isNaN(input.closesAt.getTime())) {
    return false;
  }

  return input.questions.every(
    (question) =>
      question.prompt.trim().length >= 1 &&
      question.prompt.trim().length <= 500 &&
      question.choices.length >= 2 &&
      question.choices.length <= 20 &&
      question.choices.every((choice) => {
        const label = choice.label.trim();
        return label.length >= 1 && label.length <= 300;
      }),
  );
}

/** Parses and validates the poll JSON sent by the new-topic and edit screens. */
export function parsePollInput(value: unknown): PollInput | null {
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    return null;
  }

  if (value.questions.length < 1 || value.questions.length > 10) {
    return null;
  }

  const questions: Array<{
    readonly id?: string;
    readonly prompt: string;
    readonly multiple: boolean;
    readonly choices: readonly { readonly id?: string; readonly label: string }[];
  }> = [];

  for (const rawQuestion of value.questions) {
    if (!isRecord(rawQuestion) || !Array.isArray(rawQuestion.choices)) {
      return null;
    }

    const prompt = text(rawQuestion.prompt, 500);
    const questionId = optionalId(rawQuestion.id);
    const multiple = rawQuestion.multiple === true;

    if (
      prompt === null ||
      questionId === null ||
      rawQuestion.choices.length < 2 ||
      rawQuestion.choices.length > 20
    ) {
      return null;
    }

    const choices: Array<{ id?: string; label: string }> = [];

    for (const rawChoice of rawQuestion.choices) {
      if (!isRecord(rawChoice)) {
        return null;
      }

      const label = text(rawChoice.label, 300);
      const choiceId = optionalId(rawChoice.id);

      if (label === null || choiceId === null) {
        return null;
      }

      choices.push({ ...(choiceId === undefined ? {} : { id: choiceId }), label });
    }

    questions.push({
      ...(questionId === undefined ? {} : { id: questionId }),
      prompt,
      multiple,
      choices,
    });
  }

  let closesAt: Date | null = null;

  if (typeof value.closesAt === "string" && value.closesAt !== "") {
    const parsed = new Date(value.closesAt);

    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    closesAt = parsed;
  } else if (value.closesAt !== null && value.closesAt !== undefined) {
    return null;
  }

  return {
    resultsVisibleBeforeVoting: value.resultsVisibleBeforeVoting === true,
    closesAt,
    questions,
  };
}

function validSelections(poll: PollRecord, selections: readonly VoteSelection[]): boolean {
  const byQuestion = new Map(selections.map((selection) => [selection.questionId, selection]));

  if (byQuestion.size !== selections.length) {
    return false;
  }

  for (const question of poll.questions) {
    const selection = byQuestion.get(question.id);

    if (selection === undefined) {
      return false;
    }

    const choices = new Set(question.choices.map((choice) => choice.id));
    const unique = new Set(selection.choiceIds);

    if (unique.size !== selection.choiceIds.length || selection.choiceIds.length === 0) {
      return false;
    }

    if (!question.multiple && selection.choiceIds.length !== 1) {
      return false;
    }

    if (selection.choiceIds.some((choiceId) => !choices.has(choiceId))) {
      return false;
    }
  }

  return selections.every((selection) =>
    poll.questions.some((question) => question.id === selection.questionId),
  );
}

export interface VoteInput {
  readonly actorId: string;
  readonly pollId: string;
  readonly selections: readonly VoteSelection[];
  readonly now?: Date;
}

export async function vote(
  sql: SQL,
  input: VoteInput,
): Promise<PollOutcome<{ readonly pollId: string; readonly voterCount: number }>> {
  const poll = await readPoll(sql, input.pollId);

  if (poll === null) {
    return { ok: false, code: "not_found" };
  }

  if (!(await canVoteInPoll(sql, input.actorId, poll.forumId))) {
    return { ok: false, code: "forbidden" };
  }

  const now = input.now ?? new Date();

  if (poll.closesAt !== null && poll.closesAt.getTime() <= now.getTime()) {
    return { ok: false, code: "closed" };
  }

  if ((await readPollVote(sql, poll.id, input.actorId)) !== null) {
    return { ok: false, code: "already_voted" };
  }

  if (!validSelections(poll, input.selections)) {
    return { ok: false, code: "invalid_choice" };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: pollVoteMutation,
      input: { pollId: poll.id },
      apply: async (tx) => {
        await tx`SELECT id FROM core.poll_votes WHERE poll_id = ${poll.id} FOR UPDATE`;
        const [closed] = (await tx`
          SELECT closes_at FROM core.polls WHERE id = ${poll.id} FOR UPDATE
        `) as Array<{ closes_at: Date | null }>;

        if (
          closed?.closes_at !== null &&
          closed?.closes_at !== undefined &&
          closed.closes_at.getTime() <= now.getTime()
        ) {
          reject("closed");
        }

        const [existing] = (await tx`
          SELECT 1 FROM core.poll_votes WHERE poll_id = ${poll.id} AND member_id = ${input.actorId}
        `) as unknown[];

        if (existing !== undefined) {
          reject("already_voted");
        }

        await insertPollVote(tx, poll.id, input.actorId, input.selections);
        return { pollId: poll.id, voterCount: poll.totalVoters + 1 };
      },
    });

    return { ok: true, result };
  } catch (error) {
    const failure = rejected(error);

    if (failure !== null) {
      return failure;
    }

    throw error;
  }
}

export interface PollResults {
  readonly pollId: string;
  readonly closed: boolean;
  readonly hasVoted: boolean;
  readonly totalVoters: number;
  readonly questions: readonly PollQuestionRecord[];
}

/** The private results view; callers check the same conditions per request (task 4.2). */
export async function pollResults(
  sql: SQL,
  input: {
    readonly pollId: string;
    readonly actorId: string | null;
    readonly now?: Date;
  },
): Promise<PollOutcome<PollResults>> {
  const poll = await readPoll(sql, input.pollId);

  if (poll === null) {
    return { ok: false, code: "not_found" };
  }

  if (input.actorId === null || !(await canReadPoll(sql, input.actorId, poll.forumId))) {
    return { ok: false, code: "forbidden" };
  }

  const now = input.now ?? new Date();
  const closed = poll.closesAt !== null && poll.closesAt.getTime() <= now.getTime();
  const voted = (await readPollVote(sql, poll.id, input.actorId)) !== null;
  const moderator = await canModeratePoll(sql, input.actorId, poll.forumId);

  if (!(poll.resultsVisibleBeforeVoting || voted || moderator || closed)) {
    return { ok: false, code: "forbidden" };
  }

  return {
    ok: true,
    result: {
      pollId: poll.id,
      closed,
      hasVoted: voted,
      totalVoters: poll.totalVoters,
      questions: poll.questions,
    },
  };
}

export async function editPoll(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly pollId: string;
    readonly poll: PollInput;
    readonly confirmRemoveVoted?: boolean;
    readonly now?: Date;
  },
): Promise<PollOutcome<{ readonly pollId: string }>> {
  const poll = await readPoll(sql, input.pollId);

  if (poll === null) {
    return { ok: false, code: "not_found" };
  }

  const moderator = await canModeratePoll(sql, input.actorId, poll.forumId);
  const starter = poll.starterId === input.actorId;

  if (!(await canReadPoll(sql, input.actorId, poll.forumId))) {
    return { ok: false, code: "forbidden" };
  }

  if (!moderator) {
    if (!starter) {
      return { ok: false, code: "forbidden" };
    }

    const windowMinutes = await pollEditWindowMinutes(sql, input.actorId);
    const ageMinutes = ((input.now ?? new Date()).getTime() - poll.createdAt.getTime()) / 60_000;

    if (windowMinutes > 0 && ageMinutes > windowMinutes) {
      return { ok: false, code: "edit_window_expired" };
    }
  }

  try {
    const result = await runMutation({
      sql,
      mutation: pollEditMutation,
      input: { pollId: poll.id },
      apply: async (tx) => {
        await tx`SELECT id FROM core.polls WHERE id = ${poll.id} FOR UPDATE`;
        const current = await readPoll(tx, poll.id);

        if (current === null) {
          reject("not_found");
        }

        await replacePoll(tx, current, {
          resultsVisibleBeforeVoting: input.poll.resultsVisibleBeforeVoting,
          closesAt: input.poll.closesAt,
          questions: input.poll.questions,
          allowVotedChoiceRemoval: moderator && input.confirmRemoveVoted === true,
        });
        return { pollId: current.id };
      },
    });

    return { ok: true, result };
  } catch (error) {
    if (error instanceof Error && error.message === "voted_choice") {
      return { ok: false, code: "voted_choice" };
    }

    const failure = rejected(error);

    if (failure !== null) {
      return failure;
    }

    throw error;
  }
}

/** The minute worker: rebuild the shared fragment of polls that just closed (task 4.3). */
export async function closePollTransitions(sql: SQL, now: Date = new Date()): Promise<number> {
  const ids = await recentlyClosedPollIds(sql, now);

  if (ids.length === 0) {
    return 0;
  }

  await sql.begin(async (tx) => {
    await bumpCacheTags(
      tx,
      ids.flatMap((id) => [pollTag(id), pollResultsTag(id)]),
    );
  });

  return ids.length;
}
