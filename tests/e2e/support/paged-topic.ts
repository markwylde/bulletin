/**
 * Creates a topic with enough replies to span more than one page, as a self-contained E2E
 * fixture. Paging tests must not depend on the seeded "Long running discussion", because
 * other journeys (splitting a post, for example) remove posts from it and earlier runs leave
 * it shorter than a page.
 */

export interface PagedTopicFixture {
  readonly topicId: string;
  readonly url: string;
  readonly title: string;
}

export interface PagedTopicInput {
  readonly forumId: string;
  readonly title: string;
  /** Replies after the opening post; 21 is a second page at the seeded 20 posts per page. */
  readonly replies: number;
}

export async function createPagedTopic(
  view: Bun.WebView,
  input: PagedTopicInput,
): Promise<PagedTopicFixture> {
  const fixture = await view.evaluate<PagedTopicFixture | null>(`(async () => {
    const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } })
      .then((response) => response.json());
    const headers = {
      "content-type": "application/json",
      "x-bulletin-csrf": typeof session.csrfToken === "string" ? session.csrfToken : "",
    };
    const created = await fetch(${JSON.stringify(`/api/forums/${input.forumId}/topics`)}, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: ${JSON.stringify(input.title)},
        bodyMd: "Opening post in a paging fixture.",
      }),
    });

    if (!created.ok) return null;

    const topic = await created.json();

    if (typeof topic.topicId !== "string" || typeof topic.url !== "string") return null;

    for (let index = 1; index <= ${String(input.replies)}; index += 1) {
      const reply = await fetch("/api/topics/" + topic.topicId + "/replies", {
        method: "POST",
        headers,
        body: JSON.stringify({ bodyMd: "Reply " + index + " in a paging fixture." }),
      });

      if (!reply.ok) return null;
    }

    return { topicId: topic.topicId, url: topic.url, title: ${JSON.stringify(input.title)} };
  })()`);

  if (fixture === null) {
    throw new Error("Could not create the paged topic fixture");
  }

  return fixture;
}
