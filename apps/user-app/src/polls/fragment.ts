import { i18nTag, pollResultsTag, pollTag, type RenderCache } from "@bulletin/cache";
import { type PollRecord, readPoll } from "@bulletin/domain/polls";
import type { Locale, Translator } from "@bulletin/i18n";
import { escapeHtml } from "@bulletin/templates";
import type { SQL } from "bun";

function questionHtml(question: PollRecord["questions"][number], revealed: boolean): string {
  const inputType = question.multiple ? "checkbox" : "radio";
  const choices = question.choices
    .map(
      (choice) => `<label class="bl-poll__choice">
        <input type="${inputType}" name="question-${escapeHtml(question.id)}" value="${escapeHtml(choice.id)}" data-poll-choice="${escapeHtml(choice.id)}" />
        <span>${escapeHtml(choice.label)}</span>
        <span class="bl-poll__count" data-poll-count="${escapeHtml(choice.id)}">${revealed ? choice.votes : ""}</span>
      </label>`,
    )
    .join("");

  return `<fieldset class="bl-poll__question" data-poll-question="${escapeHtml(question.id)}" data-poll-multiple="${question.multiple}">
    <legend>${escapeHtml(question.prompt)}</legend>
    ${choices}
  </fieldset>`;
}

function resultsHtml(poll: PollRecord, translate: Translator, revealed: boolean): string {
  const questions = poll.questions
    .map(
      (question) => `<li>
        <p class="bl-poll__result-prompt">${escapeHtml(question.prompt)}</p>
        <ul class="bl-poll__result-list">
          ${question.choices
            .map(
              (choice) => `<li><span>${escapeHtml(choice.label)}</span>
                <span data-poll-count="${escapeHtml(choice.id)}">${revealed ? choice.votes : ""}</span></li>`,
            )
            .join("")}
        </ul>
      </li>`,
    )
    .join("");

  return `<div class="bl-poll__results" data-poll-results ${revealed ? "" : "hidden"} aria-label="${escapeHtml(translate("poll.results"))}">
    <p class="bl-muted"><span data-poll-total>${revealed ? poll.totalVoters : ""}</span> ${escapeHtml(translate("poll.voters"))}</p>
    <ul class="bl-poll__result-questions">${questions}</ul>
  </div>`;
}

export async function renderPollFragment(
  sql: SQL,
  cache: RenderCache,
  pollId: string,
  locale: Locale,
  translate: Translator,
  now: Date = new Date(),
): Promise<string> {
  const rendered = await cache.getOrRender({
    tags: [pollTag(pollId), pollResultsTag(pollId), i18nTag(locale)],
    prepare: async () => {
      const poll = await readPoll(sql, pollId);
      const closed =
        poll?.closesAt !== null && poll?.closesAt !== undefined
          ? poll.closesAt.getTime() <= now.getTime()
          : false;
      const revealed = poll !== null && (poll.resultsVisibleBeforeVoting || closed);

      return {
        key: `poll:${pollId}:${locale}:${revealed ? 1 : 0}:${closed ? 1 : 0}`,
        data: { poll, closed, revealed },
        ...(poll?.closesAt === null || poll?.closesAt === undefined
          ? {}
          : { ttlMs: Math.max(0, poll.closesAt.getTime() - now.getTime()) }),
      };
    },
    render: ({ poll, closed, revealed }) => {
      if (poll === null) {
        return "";
      }

      const questions = poll.questions.map((question) => questionHtml(question, revealed)).join("");

      return `<section class="bl-card bl-poll" data-poll-id="${escapeHtml(poll.id)}" data-poll-closed="${closed}">
        <h2 class="bl-card__title">${escapeHtml(translate("poll.title"))}</h2>
        ${
          closed
            ? ""
            : `<form class="bl-poll__form" data-poll-form data-poll-id="${escapeHtml(poll.id)}">
                ${questions}
                <button class="bl-button" type="submit" data-poll-submit>${escapeHtml(translate("poll.vote"))}</button>
                <p class="bl-error-text" data-poll-error hidden>${escapeHtml(translate("poll.voteFailed"))}</p>
              </form>`
        }
        ${resultsHtml(poll, translate, revealed)}
      </section>`;
    },
  });

  return rendered.html;
}
