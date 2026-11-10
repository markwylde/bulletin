import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FlagsProvider, useFlag } from "./flags.tsx";

function Feature({ flag, label }: { readonly flag: string; readonly label: string }) {
  return useFlag(flag) ? <span>{label}</span> : null;
}

describe("useFlag", () => {
  test("reads a client-visible flag from the provider", () => {
    const markup = renderToStaticMarkup(
      <FlagsProvider value={{ newEditor: true, reactions: false }}>
        <Feature flag="newEditor" label="editor" />
        <Feature flag="reactions" label="reactions" />
      </FlagsProvider>,
    );

    expect(markup).toBe("<span>editor</span>");
  });

  test("fails closed for an unknown key and outside a provider", () => {
    const unknown = renderToStaticMarkup(
      <FlagsProvider value={{ newEditor: true }}>
        <Feature flag="missing" label="missing" />
      </FlagsProvider>,
    );
    const noProvider = renderToStaticMarkup(<Feature flag="newEditor" label="editor" />);

    expect(unknown).toBe("");
    expect(noProvider).toBe("");
  });
});
