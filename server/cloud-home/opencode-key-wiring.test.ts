// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenCode on a Cloud home signs in with no login mode: the existing OpenCode API key
// field (cfg.opencodeGo.apiKey) reaches the `opencode acp` turn as OPENCODE_API_KEY.
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { instanceConfigs } from "../config.ts";
import { CLOUD_ENGINES, cloudTurnEnvironment } from "./turn-process.ts";

afterEach(() => vi.unstubAllEnvs());
const KEY = "opencode-key-fixture";

it("carries the saved OpenCode key into the opencodeGo instance only", () => {
  const map = instanceConfigs({ opencodeGo: { apiKey: KEY } });
  expect(map.opencodeGo.environment).toMatchObject({ OPENCODE_API_KEY: KEY });
  for (const [id, instance] of Object.entries(map)) if (id !== "opencodeGo") expect(instance.environment ?? {}).not.toHaveProperty("OPENCODE_API_KEY");
});

it("keeps the key in the home turn env (the driver's credential grant) with updates off", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const map = instanceConfigs({ opencodeGo: { apiKey: KEY } });
  const driver = readFileSync(new URL("../drivers/acp/opencode-go.ts", import.meta.url), "utf8");
  expect(driver).toContain('credentialEnv: ["OPENCODE_API_KEY"]');
  expect(driver).toContain('spawnArgs: () => ["acp"]');
  const env = cloudTurnEnvironment("opencodeGo", { ...map.opencodeGo.environment }, ["OPENCODE_API_KEY"]);
  expect(env).toMatchObject({ OPENCODE_API_KEY: KEY, OPENCODE_DISABLE_AUTOUPDATE: "1", HOME: "/data/engine-homes/opencodeGo", PATH: "/opt/murage/bin:/usr/local/bin:/usr/bin:/bin" });
});

it("never hands the key to another engine's turn", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  for (const engine of CLOUD_ENGINES.filter(name => name !== "opencodeGo")) {
    expect(cloudTurnEnvironment(engine, { OPENCODE_API_KEY: KEY })).not.toHaveProperty("OPENCODE_API_KEY");
  }
});

it("the launcher's OpenCode allowlist names OPENCODE_API_KEY (engine-env-allowlist.test.ts drives the real Python)", () => {
  const launcher = readFileSync(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url), "utf8");
  const allow = /"opencodeGo": frozenset\(\{([^}]*)\}\)/.exec(launcher);
  expect(allow).not.toBeNull();
  expect(allow![1]).toMatch(/"OPENCODE_API_KEY"/);
});
