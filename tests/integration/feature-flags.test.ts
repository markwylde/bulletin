import { describe, expect, test } from "bun:test";
import {
  bumpFlagTag,
  createFlagDefinitionSource,
  loadFlagViewer,
  loadStoredFlags,
  readFlagVersion,
  syncFlagDefinitions,
  watchFlagInvalidation,
} from "@bulletin/db/flags";
import {
  createFlagRuntime,
  defineFlag,
  FLAG_HEARTBEAT_TIMEOUT_MS,
  type FlagViewer,
  GUEST_VIEWER,
} from "@bulletin/flags";
import { withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const MEMBER: FlagViewer = { memberId: "7", groups: ["members"] };

const ALPHA = defineFlag({
  key: "alphaFeature",
  description: "First example flag.",
  owner: "core",
  default: true,
  clientVisible: true,
});

const BETA = defineFlag({
  key: "betaFeature",
  description: "Second example flag.",
  owner: "core",
  default: false,
  affectsRender: true,
});

const GROUP_RULE = [{ type: "group", groups: ["members"], value: true }] as const;

integrationDescribe("feature flags", () => {
  test("startup upserts missing code flags and keeps stored rules", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "flags_sync" }, async ({ sql }) => {
      expect(await syncFlagDefinitions(sql, [ALPHA, BETA])).toEqual([
        "alphaFeature",
        "betaFeature",
      ]);
      expect(await readFlagVersion(sql)).toBe("1");

      const first = await loadStoredFlags(sql);
      expect(first.map((flag) => flag.key)).toEqual(["alphaFeature", "betaFeature"]);
      expect(first[0]).toMatchObject({
        defaultValue: true,
        affectsRender: false,
        clientVisible: true,
        rules: [],
      });
      expect(first[0]?.fullyOnSince).toBeInstanceOf(Date);
      expect(first[0]?.createdAt).toBeInstanceOf(Date);
      expect(first[1]?.fullyOnSince).toBeNull();
      expect(first[1]?.createdAt).toBeInstanceOf(Date);

      await sql`
        UPDATE core.feature_flags
        SET rules = ${GROUP_RULE}::jsonb, updated_at = now()
        WHERE key = ${ALPHA.key}
      `;
      await bumpFlagTag(sql);

      expect(await syncFlagDefinitions(sql, [ALPHA, BETA])).toEqual([]);

      const second = await loadStoredFlags(sql);
      expect(second[0]?.rules).toEqual(GROUP_RULE);
      expect(second[0]?.defaultValue).toBe(true);
    });
  }, 15_000);

  test("a flag change reaches an evaluator within one second", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "flags_prompt" }, async ({ sql }) => {
      await syncFlagDefinitions(sql, [BETA]);

      const runtime = createFlagRuntime(createFlagDefinitionSource(sql));
      const watch = await watchFlagInvalidation(sql, runtime);

      try {
        await runtime.ensureFresh();
        expect(runtime.isOn(MEMBER, BETA.key)).toBe(false);

        const startedAt = performance.now();

        await sql`
          UPDATE core.feature_flags
          SET rules = ${GROUP_RULE}::jsonb, updated_at = now()
          WHERE key = ${BETA.key}
        `;
        await bumpFlagTag(sql);

        let on = false;

        while (performance.now() - startedAt < 1_000) {
          await runtime.ensureFresh();
          on = runtime.isOn(MEMBER, BETA.key);

          if (on) {
            break;
          }

          await Bun.sleep(10);
        }

        expect(on).toBe(true);
        expect(performance.now() - startedAt).toBeLessThan(1_000);
      } finally {
        await watch.close();
      }
    });
  }, 15_000);

  test("bypasses the snapshot while the listener is down and trusts it again after reconnect", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "flags_listener" }, async ({ sql }) => {
      await syncFlagDefinitions(sql, [BETA]);

      const runtime = createFlagRuntime(createFlagDefinitionSource(sql), { backstopMs: 60_000 });
      const watch = await watchFlagInvalidation(sql, runtime, { heartbeatMs: 60_000 });
      let reconnected: Awaited<ReturnType<typeof watchFlagInvalidation>> | null = null;

      try {
        expect(runtime.isListenerHealthy()).toBe(true);
        await runtime.ensureFresh();
        expect(runtime.isOn(MEMBER, BETA.key)).toBe(false);

        // The listener is down, so the change is durable but its NOTIFY is never delivered.
        runtime.setListenerHealthy(false);
        expect(runtime.isListenerHealthy()).toBe(false);

        await sql`
          UPDATE core.feature_flags
          SET rules = ${GROUP_RULE}::jsonb, updated_at = now()
          WHERE key = ${BETA.key}
        `;
        await sql`
          UPDATE core.cache_tags
          SET version = version + 1, updated_at = now()
          WHERE tag = 'flags'
        `;

        await runtime.ensureFresh();
        expect(runtime.isOn(MEMBER, BETA.key)).toBe(true);

        await watch.close();
        expect(runtime.isListenerHealthy()).toBe(false);

        // Reconnecting re-listens, trusts itself and re-reads the durable tag version.
        reconnected = await watchFlagInvalidation(sql, runtime, { heartbeatMs: 60_000 });
        expect(runtime.isListenerHealthy()).toBe(true);
        await runtime.ensureFresh();
        expect(runtime.isOn(MEMBER, BETA.key)).toBe(true);
      } finally {
        await reconnected?.close();
        await watch.close();
      }
    });
  }, 15_000);

  test("stays trusted while heartbeats arrive and drops trust when they stop", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "flags_heartbeat" }, async ({ sql }) => {
      await syncFlagDefinitions(sql, [BETA]);

      let clock = 1_000;
      const runtime = createFlagRuntime(createFlagDefinitionSource(sql), {
        backstopMs: 60_000,
        now: () => clock,
      });
      const watch = await watchFlagInvalidation(sql, runtime, { heartbeatMs: 25 });

      try {
        expect(runtime.isListenerHealthy()).toBe(true);

        // No signal for longer than the ADR 0006 window makes the snapshot untrusted.
        clock += FLAG_HEARTBEAT_TIMEOUT_MS + 1;
        expect(runtime.isListenerHealthy()).toBe(false);

        // A real heartbeat arrives and restores trust at the current time.
        const startedAt = performance.now();

        while (performance.now() - startedAt < 2_000 && !runtime.isListenerHealthy()) {
          await Bun.sleep(10);
        }

        expect(runtime.isListenerHealthy()).toBe(true);
      } finally {
        await watch.close();
      }

      expect(runtime.isListenerHealthy()).toBe(false);
    });
  }, 15_000);

  test("loads a member's group keys and the guest pseudo-group", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "flags_viewer" }, async ({ sql }) => {
      const [member] = (await sql`
        INSERT INTO core.members (display_name) VALUES ('Flag Viewer') RETURNING id
      `) as Array<{ id: string }>;

      if (member === undefined) {
        throw new Error("failed to create the flag viewer");
      }

      await sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        SELECT ${member.id}, id, true FROM core.groups WHERE key = 'members'
      `;

      expect(await loadFlagViewer(sql, member.id)).toEqual({
        memberId: member.id,
        groups: ["members"],
      });
      expect(await loadFlagViewer(sql, null)).toEqual(GUEST_VIEWER);
    });
  }, 15_000);
});
