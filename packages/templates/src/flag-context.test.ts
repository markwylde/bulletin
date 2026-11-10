import { describe, expect, test } from "bun:test";
import { createFlagRuntime, defineFlag, type FlagViewer } from "@bulletin/flags";
import { Liquid } from "liquidjs";
import { createFlagTemplateContext } from "./flag-context.ts";

const MEMBER: FlagViewer = { memberId: "7", groups: ["members"] };

const definitions = [
  defineFlag({
    key: "newEditor",
    description: "Switches the new editor on.",
    owner: "content",
    default: true,
  }),
  defineFlag({
    key: "reactions",
    description: "Turns reactions on.",
    owner: "community",
    default: false,
  }),
];

async function context(): Promise<Readonly<Record<string, boolean>>> {
  const runtime = createFlagRuntime({
    version: async () => "1",
    load: async () => definitions,
  });

  await runtime.ensureFresh();
  return createFlagTemplateContext(runtime, MEMBER);
}

describe("template flag accessor", () => {
  test("renders {% if flags.key %} from the evaluated values", async () => {
    const engine = new Liquid();
    const template = engine.parse(
      "{% if flags.newEditor %}editor{% endif %}{% if flags.reactions %}reactions{% endif %}",
    );

    expect(await engine.render(template, { flags: await context() })).toBe("editor");
  });

  test("fails closed for an unknown key", async () => {
    const engine = new Liquid();
    const template = engine.parse("{% if flags.missing %}<b>leak</b>{% endif %}ok");

    expect(await engine.render(template, { flags: await context() })).toBe("ok");
  });

  test("exposes only boolean values, never definitions or raw rules", async () => {
    const values = await context();

    expect(values).toEqual({ newEditor: true, reactions: false });

    for (const value of Object.values(values)) {
      expect(typeof value).toBe("boolean");
    }
  });
});
