import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";

import type { InstallationRow } from "./index";
import { migrationGate, route } from "./index";

/**
 * The committed wrangler.jsonc is what a plain `pnpm broker:deploy` ships.
 * FluxRouter rollout steps 5-6 ran the live Worker with `--var` overrides while
 * this file still said CLAIM_MODE "closed", so one ordinary deploy would have
 * closed claims for every install mid-migration. These tests pin the file to
 * the post-step-8 state (FLUX-COMPOSIO-BROKER-DESIGN.md §8.3) and read it with
 * wrangler's own config reader, so a revert is caught the way deploy sees it.
 */
const CONFIG_PATH = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

/**
 * The cut-off the desktop already ships.
 *
 * `COMPOSIO_LEGACY_BROKER_UNTIL` is baked into every packaged 0.1.52 and
 * later, so the Worker's own `LEGACY_BROKER_UNTIL` is not free to differ: set
 * it earlier and installs are refused while their UI still expects the broker
 * to work, set it later and a client that honours its constant stops asking
 * while Ferrox keeps paying for the ones that do not. Read from the release
 * config rather than retyped, so the two can only move together.
 */
const RELEASE_CONFIG_PATH = fileURLToPath(
  new URL("../../../electron/composio-release-config.mjs", import.meta.url),
);

function desktopLegacyBrokerUntil(): string {
  const source = readFileSync(RELEASE_CONFIG_PATH, "utf8");
  const match = source.match(/COMPOSIO_LEGACY_BROKER_UNTIL\s*=\s*"([^"]*)"/);
  if (!match) throw new Error("COMPOSIO_LEGACY_BROKER_UNTIL not found in the release config");
  return match[1];
}

const LEGACY_BROKER_CUTOFF = "2026-11-10T00:00:00Z";

function committedVars(): Record<string, unknown> {
  const { rawConfig } = experimental_readRawConfig({ config: CONFIG_PATH }) as {
    rawConfig: { vars?: Record<string, unknown> };
  };
  return rawConfig.vars ?? {};
}

function claimedRow(overrides: Partial<InstallationRow> = {}): InstallationRow {
  return {
    id: "install-1",
    composio_user_id: "murage_install1",
    session_id: null,
    disabled_at: null,
    claim_issued_at: null,
    claim_confirmed_at: null,
    last_claim_jti: null,
    ...overrides,
  };
}

describe("committed Worker config (wrangler.jsonc)", () => {
  it("keeps FluxRouter claims open and Worker registration closed", () => {
    const vars = committedVars();
    expect(vars.CLAIM_MODE).toBe("open");
    expect(vars.REGISTRATION_MODE).toBe("closed");
  });

  it("matches the rest of the post-step-9 rollout state", () => {
    expect(committedVars()).toMatchObject({
      MIGRATION_GATE: "on",
      CLAIM_GRACE_SECONDS: "900",
      CLAIM_ISSUED_FALLBACK_SECONDS: "604800",
      DAILY_CALL_CEILING: "2000",
      LEGACY_BROKER_UNTIL: LEGACY_BROKER_CUTOFF,
      // Claims are the way off this Worker, so they outlive the cut-off.
      CLAIM_UNTIL: "",
    });
  });

  /**
   * The two values that decide what Ferrox pays.
   *
   * Every install still on this Worker spends the one shared Composio key, so
   * both of these were switched on deliberately and a revert costs real money
   * silently. `DAILY_CALL_CEILING` back to "off" removes the per-install fuse
   * (and stops the D1 counters being written at all, so nothing would even
   * show it); `LEGACY_BROKER_UNTIL` back to "" removes the server-side end
   * date and leaves only a desktop constant any client can ignore.
   */
  it("keeps the spend fuse on and the cut-off set", () => {
    const vars = committedVars();
    expect(vars.DAILY_CALL_CEILING).toBe("2000");
    expect(vars.DAILY_CALL_CEILING).not.toBe("off");
    expect(vars.LEGACY_BROKER_UNTIL).toBe(LEGACY_BROKER_CUTOFF);
  });

  it("uses the same cut-off the shipped desktop already honours", () => {
    expect(desktopLegacyBrokerUntil()).toBe(LEGACY_BROKER_CUTOFF);
    expect(committedVars().LEGACY_BROKER_UNTIL).toBe(desktopLegacyBrokerUntil());
  });

  it("serves data calls before the cut-off and retires them after it", async () => {
    const env = committedVars();
    const cutoff = Date.parse(LEGACY_BROKER_CUTOFF);
    expect(Number.isFinite(cutoff)).toBe(true);

    expect(migrationGate(claimedRow(), env as never, cutoff - 1)).toBeNull();

    const retired = migrationGate(claimedRow(), env as never, cutoff);
    expect(retired?.status).toBe(410);
    await expect(retired?.json()).resolves.toMatchObject({
      code: "legacy_broker_retired",
      error: "Murage's connected-apps service has ended. Connect FluxRouter in Settings to keep using connected apps.",
    });
  });

  it("refuses new installs and retires confirmed ones after grace when deployed as committed", async () => {
    const env = committedVars();
    const registration = await route(
      new Request("https://broker.test/v1/installations", { method: "POST" }),
      env as never,
      {} as never,
    );
    expect(registration.status).toBe(503);

    const now = Date.now();
    expect(migrationGate(claimedRow(), env as never, now)).toBeNull();
    expect(migrationGate(claimedRow({ claim_confirmed_at: now - 899_000 }), env as never, now)).toBeNull();
    const moved = migrationGate(claimedRow({ claim_confirmed_at: now - 901_000 }), env as never, now);
    expect(moved?.status).toBe(410);
    await expect(moved?.json()).resolves.toMatchObject({ code: "migrated_to_flux" });
  });
});
