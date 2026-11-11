import { bumpCacheTags } from "@bulletin/cache";
import type { SQL } from "bun";

/**
 * One write that invalidates cache content. Definitions live beside the feature
 * (`domain/mutations/*.ts`) and declare every tag the write invalidates — there is no ad hoc
 * invalidation anywhere else (ADR 0006).
 */
export interface Mutation<TInput, TResult> {
  readonly name: string;
  readonly tags: (input: TInput, result: TResult) => readonly string[];
}

/** Declares a mutation; identity today, a single place to add checks later. */
export function defineMutation<TInput, TResult>(
  mutation: Mutation<TInput, TResult>,
): Mutation<TInput, TResult> {
  return mutation;
}

export interface RunMutationOptions<TInput, TResult> {
  readonly sql: SQL;
  readonly mutation: Mutation<TInput, TResult>;
  readonly input: TInput;
  /** Performs the write with the transaction handle; runs before the tag bumps. */
  readonly apply: (tx: SQL, input: TInput) => Promise<TResult>;
}

export * from "./attachments.ts";
/**
 * Runs a write and bumps every tag it declared in the same transaction, so a rollback also
 * rolls back the invalidation and a commit is followed by the NOTIFY (ADR 0006).
 */
export * from "./board.ts";
export * from "./emoticons.ts";
export * from "./forums.ts";
export * from "./members.ts";
export * from "./polls.ts";
export * from "./reactions.ts";
export * from "./reputation.ts";
export * from "./topics.ts";

export async function runMutation<TInput, TResult>(
  options: RunMutationOptions<TInput, TResult>,
): Promise<TResult> {
  return options.sql.begin(async (tx) => {
    const result = await options.apply(tx, options.input);
    const tags = [...new Set(options.mutation.tags(options.input, result))];

    if (tags.length > 0) {
      await bumpCacheTags(tx, tags);
    }

    return result;
  });
}
