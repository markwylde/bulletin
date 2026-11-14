/**
 * Runs SQL against the stack's Postgres through `docker compose exec`, for E2E fixtures the
 * seed cannot provide (for example more rows than one API page). It uses the caller's
 * COMPOSE_PROJECT_NAME, so a test only ever touches its own stack.
 */
export async function composeSql(statement: string): Promise<string> {
  const child = Bun.spawn(
    [
      "docker",
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "bulletin",
      "-d",
      "bulletin",
      "-At",
      "-c",
      statement,
    ],
    { stdout: "pipe", stderr: "pipe", env: Bun.env },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    throw new Error(`psql failed (${code}): ${stderr.trim()}`);
  }

  return stdout.trim();
}
