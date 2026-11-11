/**
 * Follow state lives only in the personal overlay and in this DOM adapter: shared HTML always
 * renders the neutral buttons (ADR 0006).
 */

const SELECTOR = "[data-follow-context]";

function containers(context: string): readonly HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SELECTOR)].filter(
    (element) => element.getAttribute("data-follow-context") === context,
  );
}

/** Shows the follow or unfollow control for one rendered target. */
export function setFollowState(context: string, following: boolean): void {
  for (const container of containers(context)) {
    container.setAttribute("data-following", following ? "true" : "false");
    const follow = container.querySelector<HTMLButtonElement>('[data-follow-action="follow"]');
    const unfollow = container.querySelector<HTMLButtonElement>('[data-follow-action="unfollow"]');

    if (follow !== null) {
      follow.hidden = following;
    }

    if (unfollow !== null) {
      unfollow.hidden = !following;
    }
  }
}
