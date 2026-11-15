import { clientCsrfToken } from "../csrf.ts";
import { pollShare } from "./share.ts";

interface PollResultsPayload {
  readonly totalVoters: number;
  readonly questions: readonly {
    readonly id: string;
    readonly choices: readonly { readonly id: string; readonly votes: number }[];
  }[];
}

async function postJson(url: string, body: unknown): Promise<Response> {
  const token = await clientCsrfToken();

  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "x-bulletin-csrf": token }),
    },
    body: JSON.stringify(body),
  });
}

function selections(form: HTMLFormElement): Array<{
  readonly questionId: string;
  readonly choiceIds: string[];
}> | null {
  const result: Array<{ questionId: string; choiceIds: string[] }> = [];

  for (const question of form.querySelectorAll<HTMLElement>("[data-poll-question]")) {
    const questionId = question.dataset.pollQuestion ?? "";
    const choiceIds = [
      ...question.querySelectorAll<HTMLInputElement>("[data-poll-choice]:checked"),
    ].map((input) => input.dataset.pollChoice ?? "");

    if (choiceIds.length === 0) {
      return null;
    }

    result.push({ questionId, choiceIds });
  }

  return result.length === 0 ? null : result;
}

function showResults(section: HTMLElement): void {
  const results = section.querySelector<HTMLElement>("[data-poll-results]");

  if (results !== null) {
    results.hidden = false;
  }
}

async function fillResults(pollId: string): Promise<void> {
  try {
    const response = await fetch(`/api/polls/${pollId}/results`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as PollResultsPayload;
    const section = document.querySelector<HTMLElement>(`[data-poll-id="${pollId}"]`);

    if (section === null) {
      return;
    }

    showResults(section);

    for (const question of payload.questions) {
      const votes = question.choices.reduce((sum, choice) => sum + choice.votes, 0);

      for (const choice of question.choices) {
        const count = section.querySelector<HTMLElement>(
          `[data-poll-results] [data-poll-count="${choice.id}"]`,
        );

        if (count !== null) {
          count.textContent = String(choice.votes);
          count
            .closest<HTMLElement>(".bl-poll__result")
            ?.style.setProperty("--bl-poll-share", `${pollShare(choice.votes, votes)}%`);
        }
      }
    }

    const total = section.querySelector<HTMLElement>("[data-poll-results] [data-poll-total]");

    if (total !== null) {
      total.textContent = String(payload.totalVoters);
    }
  } catch {
    // Results are an enhancement; the ballot still worked.
  }
}

function markVoted(pollId: string): void {
  const section = document.querySelector<HTMLElement>(`[data-poll-id="${pollId}"]`);

  if (section === null) {
    return;
  }

  const form = section.querySelector<HTMLFormElement>("[data-poll-form]");

  if (form !== null) {
    form.hidden = true;
  }

  void fillResults(pollId);
}

document.addEventListener("submit", (event) => {
  const form = event.target;

  if (!(form instanceof HTMLFormElement) || !form.matches("[data-poll-form]")) {
    return;
  }

  event.preventDefault();
  const pollId = form.dataset.pollId ?? "";
  const chosen = selections(form);

  if (chosen === null) {
    const error = form.querySelector<HTMLElement>("[data-poll-error]");

    if (error !== null) {
      error.hidden = false;
    }

    return;
  }

  const submit = form.querySelector<HTMLButtonElement>("[data-poll-submit]");

  if (submit !== null) {
    submit.disabled = true;
  }

  void postJson(`/api/polls/${pollId}/vote`, { selections: chosen })
    .then(async (response) => {
      if (!response.ok) {
        const error = form.querySelector<HTMLElement>("[data-poll-error]");

        if (error !== null) {
          error.hidden = false;
        }

        return;
      }

      markVoted(pollId);
    })
    .catch(() => {
      const error = form.querySelector<HTMLElement>("[data-poll-error]");

      if (error !== null) {
        error.hidden = false;
      }
    })
    .finally(() => {
      if (submit !== null) {
        submit.disabled = false;
      }
    });
});

if (document.documentElement.dataset.visitor !== "member") {
  // Guests keep the shared ballot (questions and choices) so they can read the poll, but the
  // controls cannot vote: the API rejects unauthenticated votes and the member overlay reveals
  // results after a member votes (ADR 0006).
  for (const form of document.querySelectorAll<HTMLFormElement>("[data-poll-form]")) {
    form.dataset.pollGuest = "true";

    for (const input of form.querySelectorAll<HTMLInputElement>("input[data-poll-choice]")) {
      input.disabled = true;
    }

    const submit = form.querySelector<HTMLButtonElement>("[data-poll-submit]");

    if (submit !== null) {
      submit.disabled = true;
    }
  }
}

window.addEventListener("bulletin:poll-voted", (event) => {
  const detail = (event as CustomEvent<{ readonly pollId?: unknown; readonly hasVoted?: unknown }>)
    .detail;

  if (typeof detail?.pollId === "string" && detail.hasVoted === true) {
    markVoted(detail.pollId);
  }
});
