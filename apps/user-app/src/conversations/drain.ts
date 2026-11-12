export interface LiveMessagePage<T> {
  readonly messages: readonly T[];
  readonly hasMore: boolean;
}

export interface DrainResult {
  readonly after: string;
  readonly appended: number;
}

/**
 * Fetches every advertised batch from the server, advancing the cursor only after a message
 * was accepted into the DOM. Returns the last rendered id so the read marker never runs ahead
 * of what the member can see (review finding P2).
 */
export async function drainLiveMessages<T extends { readonly id: string }>(input: {
  readonly after: string;
  readonly fetchPage: (after: string) => Promise<LiveMessagePage<T> | null>;
  readonly accept: (message: T) => boolean;
  readonly maxBatches?: number;
}): Promise<DrainResult> {
  let after = input.after;
  let appended = 0;
  const maxBatches = input.maxBatches ?? 10;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const page = await input.fetchPage(after);

    if (page === null) {
      break;
    }

    let accepted = 0;

    for (const message of page.messages) {
      if (input.accept(message)) {
        after = message.id;
        accepted += 1;
        appended += 1;
      }
    }

    if (page.hasMore !== true || accepted === 0) {
      break;
    }
  }

  return { after, appended };
}
