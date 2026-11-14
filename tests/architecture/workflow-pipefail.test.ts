import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A step that pipes (`cmd | tee log`) reports the exit status of the last command unless the
 * shell runs with pipefail, so a failing load test or drill would pass the step. GitHub and
 * Gitea Actions run `shell: bash` as `bash -e -o pipefail`; the default `sh -e` does not.
 */

const WORKFLOWS = join(import.meta.dir, "../../.github/workflows");

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly shell?: string;
}

interface Workflow {
  readonly defaults?: { readonly run?: { readonly shell?: string } };
  readonly jobs?: Record<
    string,
    {
      readonly defaults?: { readonly run?: { readonly shell?: string } };
      readonly steps?: readonly Step[];
    }
  >;
}

/** A pipe outside quotes, not `||`. */
function pipes(command: string): boolean {
  const unquoted = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "");
  return /(^|[^|])\|(?!\|)/.test(unquoted);
}

function pipefailShell(shell: string | undefined): boolean {
  return shell === "bash" || (shell?.includes("pipefail") ?? false);
}

function stepsWithoutPipefail(workflow: Workflow): string[] {
  const offenders: string[] = [];

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (step.run === undefined || !pipes(step.run)) {
        continue;
      }

      const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;

      if (!pipefailShell(shell) && !step.run.includes("set -o pipefail")) {
        offenders.push(`${jobName}: ${step.name ?? `step ${index + 1}`}`);
      }
    }
  }

  return offenders;
}

describe("workflow steps that pipe fail when any command fails", () => {
  test("detects a piped step under the default shell", () => {
    const planted = Bun.YAML.parse(`
jobs:
  load:
    steps:
      - name: Run the load test
        run: bun scripts/load-test.ts | tee load-report.txt
      - name: Fallback is fine
        run: test -f a || echo missing
`) as Workflow;
    expect(stepsWithoutPipefail(planted)).toEqual(["load: Run the load test"]);
    expect(stepsWithoutPipefail({ ...planted, defaults: { run: { shell: "bash" } } })).toEqual([]);
  });

  for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))) {
    test(`${file} runs every piped step with pipefail`, () => {
      const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
      expect(stepsWithoutPipefail(workflow)).toEqual([]);
    });
  }
});
