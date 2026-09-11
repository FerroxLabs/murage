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

  it("matches the rest of the post-step-8 rollout state", () => {
    expect(committedVars()).toMatchObject({
      MIGRATION_GATE: "on",
      CLAIM_GRACE_SECONDS: "900",
      CLAIM_ISSUED_FALLBACK_SECONDS: "604800",
      DAILY_CALL_CEILING: "off",
      // Step 9 (the cut-off) sets both; until then no install is retired by date.
      LEGACY_BROKER_UNTIL: "",
      CLAIM_UNTIL: "",
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
