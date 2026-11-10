import { describe, expect, test } from "bun:test";
import {
  declaredIslands,
  declaredIslandsIn,
  missingDeclaredIslands,
  missingRenderedIslands,
  renderedIslands,
} from "./islands.ts";

describe("renderedIslands", () => {
  test("reads island names from rendered markup", () => {
    expect(
      renderedIslands(
        '<p>x</p><bl-island data-name="Editor" data-props="{}"></bl-island>' +
          '<bl-island data-name="Counter" data-props="{}"></bl-island>',
      ),
    ).toEqual(["Editor", "Counter"]);
  });

  test("ignores islands with the same name twice and empty markup", () => {
    expect(
      renderedIslands(
        '<bl-island data-name="Editor"></bl-island><bl-island data-name="Editor"></bl-island>',
      ),
    ).toEqual(["Editor"]);
    expect(renderedIslands("<p>no islands</p>")).toEqual([]);
  });

  test("missingRenderedIslands reports only the required islands that are absent", () => {
    const html = '<bl-island data-name="Editor"></bl-island>';

    expect(missingRenderedIslands(html, ["Editor", "Counter"])).toEqual(["Counter"]);
    expect(missingRenderedIslands(html, ["Editor"])).toEqual([]);
    expect(missingRenderedIslands("<p>none</p>", ["Editor"])).toEqual(["Editor"]);
  });
});

describe("declaredIslands", () => {
  test("reads literal island names a template places", () => {
    expect(
      declaredIslands("<main>{% island \"Editor\" props %}{% island 'Attachment' %}</main>"),
    ).toEqual(["Editor", "Attachment"]);
  });

  test("ignores islands placed through a variable and non-island tags", () => {
    expect(declaredIslands('{% island islandName %}{% hook "x" %}')).toEqual([]);
  });

  test("unions the declarations across a theme's templates", () => {
    const templates = {
      page: '{% island "Editor" props %}',
      header: "{% island 'Search' %}",
      footer: "<p>no islands</p>",
    };

    expect([...declaredIslandsIn(templates)].sort()).toEqual(["Editor", "Search"]);
  });

  test("missingDeclaredIslands reports the islands a theme omits", () => {
    const templates = { page: '{% island "Editor" props %}' };

    expect(missingDeclaredIslands(templates, ["Editor"])).toEqual([]);
    expect(missingDeclaredIslands(templates, ["Editor", "Counter"])).toEqual(["Counter"]);
  });
});
