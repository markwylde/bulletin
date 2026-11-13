import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FlagsProvider } from "../flags.tsx";
import { PluginApp } from "./PluginApp.tsx";

const props = {
  pluginId: "tip-jar",
  version: "1",
  app: "client/index.html",
  viewJson: "{}",
};

describe("PluginApp island", () => {
  test("renders a plugin slot only while the plugins flag is on", () => {
    const off = renderToStaticMarkup(
      <FlagsProvider value={{ plugins: false }}>
        <PluginApp {...props} />
      </FlagsProvider>,
    );
    const on = renderToStaticMarkup(
      <FlagsProvider value={{ plugins: true }}>
        <PluginApp {...props} />
      </FlagsProvider>,
    );

    expect(off).toBe("");
    expect(on).toContain('data-plugin-id="tip-jar"');
    expect(on).toContain('data-app="client/index.html"');
  });
});
