import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginApp } from "./PluginApp.tsx";
import { pluginAppIsland, SERVER_ISLANDS } from "./server.tsx";

const props = {
  pluginId: "tip-jar",
  version: "1",
  app: "client/index.html",
  viewJson: "{}",
};

describe("PluginApp island", () => {
  test("renders the plugin slot with its hook data", () => {
    const html = renderToStaticMarkup(<PluginApp {...props} />);

    expect(html).toContain('data-plugin-id="tip-jar"');
    expect(html).toContain('data-app="client/index.html"');
    expect(html).not.toContain("data-origin");
  });

  test("carries the configured origin on a different registrable domain (ADR 0018)", () => {
    const html = renderToStaticMarkup(
      <PluginApp {...props} origin="https://plugins.forum-usercontent.com" />,
    );

    expect(html).toContain('data-origin="https://plugins.forum-usercontent.com"');
  });

  test("the server island injects the host origin and overrides a template's value", () => {
    const island = pluginAppIsland("https://plugins.forum-usercontent.com");
    const parsed = island.parse({ ...props, origin: "https://evil.example.com" });

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(parsed.props).toMatchObject({
        origin: "https://plugins.forum-usercontent.com",
      });
    }
  });

  test("rejects an origin that is not an exact https origin", () => {
    for (const origin of [
      "https://plugins.example.com/app/index.html",
      "http://plugins.example.com",
      "https://user:pass@plugins.example.com",
      "javascript:alert(1)",
    ]) {
      expect(SERVER_ISLANDS.PluginApp?.parse({ ...props, origin }).ok).toBe(false);
    }

    expect(
      SERVER_ISLANDS.PluginApp?.parse({
        ...props,
        origin: "http://plugins.bulletin.localhost:18080",
      }).ok,
    ).toBe(true);
  });
});
