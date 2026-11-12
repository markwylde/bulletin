import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { FlagsProvider } from "../flags.tsx";
import { ThemeChooser } from "./ThemeChooser.tsx";

const labels = {
  theme: "Theme",
  scheme: "Colour scheme",
  save: "Apply",
  failed: "Could not save",
  system: "System",
  light: "Light",
  dark: "Dark",
};

function render(flags: Readonly<Record<string, boolean>>): string {
  return renderToString(
    createElement(FlagsProvider, { value: flags }, createElement(ThemeChooser, { labels })),
  );
}

describe("ThemeChooser island flag", () => {
  test("stays hidden when theme_chooser is off", () => {
    for (const html of [render({ theme_chooser: false }), render({})]) {
      expect(html).toContain("data-appearance-chooser");
      expect(html).toContain("hidden");
    }
  });

  test("renders the chooser when theme_chooser is on", () => {
    const html = render({ theme_chooser: true });

    expect(html).toContain("data-appearance-chooser");
    expect(html).toContain("data-appearance-theme");
    expect(html).toContain("data-appearance-scheme");
    expect(html).toContain("Theme");
  });
});
