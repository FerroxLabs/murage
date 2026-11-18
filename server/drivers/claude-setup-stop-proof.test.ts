// SPDX-License-Identifier: AGPL-3.0-or-later
// Proof producer: trainred-stopwrite-b (Claude knowsTurnClose); consumer: trainred-stopwrite-b (server Stop-asked folder lease).
// A Stop that reaches a turn in setup, before any child exists, records a
// positive close proof once setup ends, because no child could have written.
// knowsTurnClose separately says no child of that turn was watched.
// Every process here belongs to this isolated fixture.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver } from "./claude.ts";
// The one setup await this witness holds: the local-host model lookup a
// non-catalog model name asks for before the engine is spawned.
const lookup = vi.hoisted(() => ({ entered: () => {}, release: () => {} }));
vi.mock("./local-inject.ts", async original => {
  const api = await original<typeof import("./local-inject.ts")>();
  return { ...api, probeLocalInjects: () => new Promise<never[]>(resolve => { lookup.release = () => resolve([]); lookup.entered(); }) };
});
const cli = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
let instance: ProviderInstance | undefined, root: string | undefined;
afterEach(async () => { lookup.release(); await instance?.dispose(); instance = undefined; if (root) await removeTempDir(root); root = undefined; });

it("a Stop that reaches a turn in setup watches no child of it (knowsTurnClose false); a turn that ran to its result is watched", async () => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-setup-stop-"));
  instance = await ClaudeDriver.create({ instanceId: "setup-stop", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root,
      CLAUDE_CONFIG_DIR: root, FAKE_CLAUDE_MCP_STATUS: "error" } });
  const events = recordEvents(instance.adapter);
  try {
    const entered = new Promise<void>(resolve => { lookup.entered = resolve; });
    const sending = instance.adapter.sendTurn(fixtureMountTurn({ threadId: "setup-stop", cwd: root, text: "fixture", draftOnly: true, model: "fixture-local-model" }));
    sending.catch(() => undefined);
    await entered;
    const stopped = instance.adapter.interruptTurn("setup-stop");
    // Setup ends only once its held step returns, so the Stop lands first.
    lookup.release();
    const ended = await events.until(event => event.type === "turn.completed" && event.threadId === "setup-stop");
    // MAIN Q1=B: setup has ended without a child, so the close is confirmed.
    expect(await stopped).toEqual({ closeConfirmed: true });
    expect(await instance.adapter.awaitTurnTeardown!("setup-stop", ended.turnId)).toEqual({ closeConfirmed: true });
    await expect(instance.adapter.awaitTurnClose!("setup-stop", ended.turnId!)).resolves.toBeUndefined();
    expect(instance.adapter.knowsTurnClose!("setup-stop", ended.turnId!)).toBe(false);
    await sending.catch(() => undefined);
    const next = await instance.adapter.sendTurn(fixtureMountTurn({ threadId: "setup-stop", cwd: root, text: "fixture", draftOnly: true }));
    expect(await events.until(event => event.type === "turn.completed" && event.turnId === next.turnId)).toMatchObject({ ok: true });
    expect(instance.adapter.knowsTurnClose!("setup-stop", next.turnId)).toBe(true);
    expect(instance.adapter.knowsTurnClose!("another-thread", next.turnId)).toBeUndefined();
    expect(instance.adapter.knowsTurnClose!("setup-stop", "unknown-turn")).toBeUndefined();
  } finally { events.stop(); }
}, 30000);
