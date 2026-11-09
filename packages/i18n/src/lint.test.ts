import { describe, expect, test } from "bun:test";
import { findHardCodedStrings, formatHardCodedString } from "./lint.ts";

describe("hard-coded JSX strings", () => {
  test("flags a planted JSX text node", () => {
    const findings = findHardCodedStrings(
      `export function Page() { return <main><h1>Welcome back</h1></main>; }`,
      "apps/forum/src/Page.tsx",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "apps/forum/src/Page.tsx",
      line: 1,
      kind: "text",
      text: "Welcome back",
    });
    expect(formatHardCodedString(findings[0] as NonNullable<(typeof findings)[0]>)).toContain(
      "Welcome back",
    );
  });

  test("flags literal values on user-facing attributes", () => {
    const findings = findHardCodedStrings(
      `<form>
        <input title="Search" placeholder="Find a topic" aria-label="Search topics" />
        <button aria-label={"Send"} />
      </form>`,
      "Search.tsx",
    );

    expect(findings.map((finding) => finding.prop)).toEqual([
      "title",
      "placeholder",
      "aria-label",
      "aria-label",
    ]);
  });

  test("flags a literal hidden in a JSX expression", () => {
    const findings = findHardCodedStrings(`<p>{"Read more"}</p>`, "ReadMore.tsx");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.text).toBe("Read more");
  });

  test("allows translated nodes and dynamic attributes", () => {
    const findings = findHardCodedStrings(
      `<h1>{t(locale, "topic.title")}</h1>
       <input placeholder={t(locale, "search.placeholder")} />
       <p>{count} replies</p>
       <span>&nbsp; · </span>`,
      "Translated.tsx",
    );

    expect(findings.map((finding) => finding.text)).toEqual(["replies"]);
  });

  test("ignores strings that are not JSX", () => {
    const findings = findHardCodedStrings(
      `const className = "card card-wide"; const key = "topic.title";`,
      "logic.tsx",
    );

    expect(findings).toEqual([]);
  });
});
