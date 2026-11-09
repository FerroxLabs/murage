import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
// Fuigo 1.0.37 checks a call approved without a grant in an ACP client terminal: folder trust, shell, then the
// environment, and it can refuse. Fuigo uses a client terminal only when the client says it has one
// (select_terminal_backend_kind, resolve_client_io_caps) or a leader injects `clientTerminal`. Murage says neither
// and starts Fuigo with --no-leader, so every shell command runs in Fuigo's own runner at every permission level.
// This test holds that launch; a change that offers a terminal must first re-run FUIGO-TRUST-V2's 1.0.37 check.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderDriver } from "../../contracts.ts";
import { turnPermissionEnforcement } from "../../routine-permissions.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import type { AcpConfig } from "./core.ts";
import { FuigoAgentDriver } from "./fuigo.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const homes: string[] = [];
beforeEach(() => {
  ensureDirs();
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|MODEL_REFRESH/i.test(key)) vi.stubEnv(key, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) removeTempDirSync(home);
});

async function launch(options: { fullAuto: boolean; enforced?: ReturnType<typeof turnPermissionEnforcement> }) {
  const home = mkdtempSync(join(tmpdir(), "murage-fuigo-1037-"));
  homes.push(home);
  const dump = join(home, "spawn.json");
  const log = join(home, "rpc.jsonl");
  const driver = FuigoAgentDriver as unknown as ProviderDriver<AcpConfig>;
  const instance = await driver.create({ instanceId: "fuigo-1037", displayName: "Fuigo", enabled: true,
    config: driver.decodeConfig({ cli, fullAuto: options.fullAuto }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_RPC_FULL_LOG: log, FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model", FUIGO_API_KEY: "sk-flux-fixture-only" } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "f1037", text: "hello", cwd: home, ...options.enforced });
    await recorder.until((event) => event.threadId === "f1037" && event.type === "turn.completed", 15000);
  } finally { recorder.stop(); await instance.dispose(); }
  const sent = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: { clientCapabilities?: Record<string, unknown>; _meta?: Record<string, unknown> } | null });
  return { argv: (JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] }).argv, sent };
}

// Each level's enforcement comes from the bot flags through the code the server runs, not from a hand-written object.
const LEVELS = [
  ["Ask", { autoApprove: false }, false, { routeAsks: true, askLevel: true }],
  ["Auto", { autoApprove: true }, true, { routeAsks: true }],
  ["Full access", { autoApprove: true, fullAccess: true }, true, { stopLine: true }],
  ["No limits", { autoApprove: true, fullAccess: true, noLimits: true }, true, { stopLine: true }],
] as const;

describe("Fuigo 1.0.37: an ACP client terminal is never on offer", () => {
  const noClientTerminal = ({ argv, sent }: Awaited<ReturnType<typeof launch>>) => {
    expect(argv).toContain("--no-leader");
    const init = sent.find((message) => message.method === "initialize");
    expect(init?.params?.clientCapabilities).toBeDefined();
    expect(init?.params?.clientCapabilities?.terminal).not.toBe(true);
    const sessions = sent.filter((message) => message.method === "session/new" || message.method === "session/load");
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) expect(session.params?._meta?.clientTerminal).not.toBe(true);
  };
  const permissionMode = (argv: string[]) => argv[argv.indexOf("--permission-mode") + 1];

  it.each(LEVELS)("%s: Fuigo asks Murage on every call, no terminal capability, no leader, no clientTerminal", async (_level, bot, fullAuto, enforced) => {
    expect(turnPermissionEnforcement(bot)).toEqual(enforced);
    const run = await launch({ fullAuto, enforced: turnPermissionEnforcement(bot) });
    expect(permissionMode(run.argv)).toBe("default");
    noClientTerminal(run);
  }, 30000);

  it("an instance set to approve everything, with no turn enforcement: Fuigo still asks and Murage answers, no terminal", async () => {
    const run = await launch({ fullAuto: true });
    expect(permissionMode(run.argv)).toBe("default");
    noClientTerminal(run);
  }, 30000);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
