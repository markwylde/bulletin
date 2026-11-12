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
  /** Retries a transient fetch failure from the last rendered id (review finding P2). */
  readonly maxRetries?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}): Promise<DrainResult> {
  let after = input.after;
  let appended = 0;
  const maxBatches = input.maxBatches ?? 10;
  const maxRetries = input.maxRetries ?? 3;
  const wait =
    input.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let batch = 0; batch < maxBatches; batch += 1) {
    let page: LiveMessagePage<T> | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      page = await input.fetchPage(after);

      if (page !== null) {
        break;
      }

      if (attempt < maxRetries) {
        await wait(500 * 2 ** attempt);
      }
    }

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
