// SPDX-License-Identifier: AGPL-3.0-or-later
// fprod4 A witness: at No limits an Allow the guard holds (a wipe) writes nothing and the ask stays answerable; a Deny ends the turn.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as providerRelease from '../../decision/provider-release.ts';
import type { ProviderInstance } from "../../contracts.ts";
import { ensureDirs } from "../../config.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { driverOwnerDecisionFixture } from "../../testing/driver-decision-fixture.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { createAcpDriver } from "./core.ts";
import { createOpenclawPrePromptGuard, openclawSupport } from "./openclaw.ts";

let instance: ProviderInstance | undefined;
let root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); await instance?.dispose(); instance = undefined; if (root) await removeTempDir(root); root = undefined; });

it.each(['wipe', 'allow', 'late-hold'] as const)("No limits %s completes or leaves a held wipe answerable", async mode => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "murage-held-"));
  const cli = join(process.cwd(), "server/testing/fake-acp-cli.ts"); chmodSync(cli, 0o755);
  const command = mode === 'wipe' ? 'rm -rf /' : 'printf fixture';
  const dump = join(root, 'engine.json');
  const params = { sessionId: "current", toolCall: { toolCallId: "exec:fixture", title: "Command approval requested", kind: "execute", status: "pending",
    rawInput: { name: "exec", approvalId: "fixture", command }, _meta: { toolName: "exec", approvalId: "fixture" } },
    options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] };
  const driver = createAcpDriver({ ...openclawSupport, prePrompt: createOpenclawPrePromptGuard({ probeVersion: async () => "2026.10.5",
    call: async (_cli, _method, p) => ({ ok: true, key: p.key, entry: { permissionMode: p.permissionMode } }) }), fluxReach: () => "elsewhere" as const });
  instance = await driver.create({ instanceId: "held", displayName: "OpenClaw", enabled: true, config: { cli, fullAuto: false },
    environment: { FAKE_ACP_MODE: "vendor-question", FAKE_ACP_DUMP: dump, FAKE_ACP_ASK_METHOD: "session/request_permission", FAKE_ACP_ASK_PARAMS: JSON.stringify(params) } });
  const events = recordEvents(instance.adapter), release = driverOwnerDecisionFixture(instance.adapter, root);
  const guard = providerRelease.guardEngineRelease;
  let checks = 0;
  vi.spyOn(providerRelease, 'guardEngineRelease').mockImplementation((...args) => {
    checks++;
    return mode === 'late-hold' && checks >= 2 ? false : guard(...args);
  });
  try {
    const sent = await instance.adapter.sendTurn({ threadId: "held", text: "fixture", cwd: root, stopLine: true, noLimits: true });
    const ask = await events.until(e => e.type === "request.opened");
    if (ask.type !== "request.opened") throw new Error("missing native request");
    if (mode === 'allow') {
      expect(await instance.adapter.respondToRequest(ask.threadId, ask.requestId!, { behavior: 'allow' })).toBe('allowed-once');
      expect(checks).toBe(2);
      expect(await events.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 4000)).toMatchObject({ok:true});
      expect(JSON.parse(readFileSync(dump, 'utf8')).decision).toMatchObject({outcome:{outcome:'selected',optionId:'allow-once'}});
      expect(events.events.find(e => e.type === 'request.resolved' && e.requestId === ask.requestId)).toMatchObject({behavior:'allow'});
      return;
    }
    // The guard holds the wipe: nothing is written, the ask stays open for the owner's answer (not a hang: Deny ends the turn at once).
    if (mode === 'late-hold') await expect(instance.adapter.respondToRequest(ask.threadId, ask.requestId!, {behavior:'allow'})).rejects.toThrow('Your approval could not be delivered');
    else expect(await instance.adapter.respondToRequest(ask.threadId, ask.requestId!, { behavior: "allow" })).toBe("unavailable");
    expect(checks).toBe(mode === 'wipe' ? 1 : 4);
    await expect(events.until(e => e.type === "turn.completed" && e.turnId === sent.turnId, 1500)).rejects.toThrow();
    expect(events.events.some(e => e.type === "request.resolved" && e.requestId === ask.requestId)).toBe(false);
    expect(JSON.parse(readFileSync(dump, 'utf8')).decision).toBeUndefined();
    expect(await instance.adapter.respondToRequest(ask.threadId, ask.requestId!, { behavior: "deny" })).toBe("rejected");
    expect(await events.until(e => e.type === "turn.completed" && e.turnId === sent.turnId, 4000)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(dump, 'utf8')).decision).toMatchObject({outcome:{outcome:'selected',optionId:'deny'}});
    expect(events.events.find(e => e.type === "request.resolved" && e.requestId === ask.requestId)).toMatchObject({ behavior: "deny" });
  } finally { events.stop(); release(); }
});
useOutsideStoreFixture();
