// SPDX-License-Identifier: AGPL-3.0-or-later
// Lane C2, broker -> integration -> service: the REAL broker on a real Unix socket, the real integration and service, and a fake extension on the wire.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { runNativeHost, readHostConfig, FrameDecoder, encodeFrame } from "../electron/browser-extension-host.mjs";
import { BrowserExtensionIntegration } from "./browser-extension-integration.ts";
import type { BotRecord } from "./store.ts";

const ROOT = process.platform === "win32" ? os.tmpdir() : realpathSync("/tmp");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function world(extra: Record<string, unknown> = {}) {
  const dataDir = await fs.mkdtemp(path.join(ROOT, "c2d-")); const socketDir = await fs.mkdtemp(path.join(ROOT, "c2s-"));
  await fs.chmod(dataDir, 0o700); await fs.chmod(socketDir, 0o700);
  cleanup.push(() => fs.rm(dataDir, { recursive: true, force: true }), () => fs.rm(socketDir, { recursive: true, force: true }));
  const botRecord = { id: "bot", name: "Bot", threadId: "thread", useMyChrome: true, browserTransport: "extension", browserExtensionProfileId: "profile", browserApproval: "full" } as BotRecord;
  const modes: string[] = [];
  const integration = new BrowserExtensionIntegration({ dataDir, socketDir, workspaceId: "workspace", approvalBus: { store: { bots: [], groups: [], messagesFor: () => [] } } as never,
    bot: (id: string) => id === "bot" ? botRecord : undefined, protectedOrigins: [],
    setMode: (_bot: string, mode: string) => { modes.push(mode); (botRecord as { browserApproval?: string }).browserApproval = mode === "task" ? undefined : mode; }, ...extra } as never);
  cleanup.push(() => integration.close());
  await integration.start();
  const input = new PassThrough(), output = new PassThrough(); const sent: any[] = [];
  const runtime = new Map<string, { generation: number; state: string }>();
  const decoder = new FrameDecoder((value: any) => {
    sent.push(value);
    if (value.type !== "command") return;
    let b = runtime.get(value.bindingId); if (!b) { b = { generation: 1, state: "active" }; runtime.set(value.bindingId, b); }
    if (value.operation === "stop" || value.operation === "pause") { b.generation++; b.state = value.operation === "stop" ? "stopped" : "paused"; }
    input.write(encodeFrame({ version: 1, type: "response", id: value.id, bindingId: value.bindingId, generation: value.generation,
      result: { generation: b.generation, state: b.state, tabs: [{ tabId: runtime.size, navigationEpoch: 1, origin: "https://fixture.test", url: "https://fixture.test/" }] } }));
  });
  output.on("data", chunk => decoder.push(chunk));
  const host = runNativeHost({ input, output, config: readHostConfig((integration as any).broker.configPath) }); cleanup.push(async () => host.stop());
  input.write(encodeFrame({ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0",
    capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] }));
  await expect.poll(() => integration.status().profiles.length).toBe(1);
  const binding = await integration.bind(botRecord, "thread");
  const wire = (message: object) => input.write(encodeFrame({ version: 1, ...message }));
  const state = () => integration.status().bindings.find(b => b.bindingId === binding.bindingId) as any;
  return { integration, binding, wire, state, modes, botRecord, runtime };
}

describe("C2 RES-002 through the real broker", () => {
  it("an uncertain restart report cancels the old cards, pauses the binding and shows outcome-unknown", async () => {
    const w = await world(); const cancel = vi.spyOn(w.integration.approvals, "cancelBinding");
    w.wire({ type: "response", id: "old_77", bindingId: w.binding.bindingId, generation: w.binding.generation, error: { code: "uncertain", message: "The browser restarted during the last action." } });
    await expect.poll(() => w.state().outcomeUnknown).toBe(true);
    expect(w.state()).toMatchObject({ state: "paused", pausedReason: "uncertain" });
    expect(cancel).toHaveBeenCalledWith(w.binding.bindingId);
  });
  it("the owner hears one plain line, and an owner_revoked notice still reaches the service", async () => {
    const lines: string[] = [];
    const w = await world({ outcomeUnknown: (info: { text: string }) => lines.push(info.text) });
    const handle = vi.spyOn((w.integration as any).service, "handleMessage");
    w.wire({ type: "response", id: "old_77", bindingId: w.binding.bindingId, generation: w.binding.generation, error: { code: "uncertain", message: "x" } });
    await expect.poll(() => lines.length).toBe(1);
    expect(lines[0]).toMatch(/may not have finished/); expect(lines[0]).not.toMatch(/\u2014/);
    w.wire({ type: "event", bindingId: w.binding.bindingId, generation: w.binding.generation, event: "notice", data: { kind: "owner_revoked", origin: "https://fixture.test" } });
    await expect.poll(() => handle.mock.calls.some(call => (call[1] as any).data?.kind === "owner_revoked")).toBe(true);
  });
  it("any other request-less response is ignored", async () => {
    const w = await world();
    w.wire({ type: "response", id: "old_78", bindingId: w.binding.bindingId, generation: 1, result: {} });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(w.state().state).toBe("active");
  });
});

describe("C2 panel buttons reach the app through the real broker", () => {
  const notice = (w: Awaited<ReturnType<typeof world>>, data: object) => w.wire({ type: "event", bindingId: w.binding.bindingId, generation: w.binding.generation, event: "notice", data });
  it("tightens the mode and never loosens it", async () => {
    const w = await world();
    notice(w, { kind: "owner_set_mode", mode: "task" });
    await expect.poll(() => w.modes).toEqual(["task"]);
    notice(w, { kind: "owner_set_mode", mode: "full" }); notice(w, { kind: "owner_set_mode", mode: "task" });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(w.modes).toEqual(["task"]);
  });
  it("Turn off leaves Full; End task ends the task; New task after Stop issues a fresh binding", async () => {
    const w = await world();
    notice(w, { kind: "owner_turn_off" });
    await expect.poll(() => w.modes).toEqual(["task"]);
    await w.integration.ownerAction(w.binding.bindingId, "stop");
    notice(w, { kind: "owner_new_task" });
    await expect.poll(() => w.integration.status().bindings.length).toBe(2);
    const [oldOne, fresh] = w.integration.status().bindings as any[];
    expect(oldOne.state).toBe("stopped"); expect(fresh.bindingId).not.toBe(oldOne.bindingId);
  });
  it("a panel request from another profile is ignored", async () => {
    const w = await world();
    w.integration.handleBrokerMessage("someone-else", { version: 1, type: "event", bindingId: w.binding.bindingId, generation: 1, event: "notice", data: { kind: "owner_turn_off" } } as never);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(w.modes).toEqual([]);
  });
});

describe("C2 owner actions: Continue is not for the phone", () => {
  it("refuses Continue from the phone, refuses a plain Resume on a hand-over, and a new task is the owner's", async () => {
    const w = await world();
    await expect(w.integration.ownerAction(w.binding.bindingId, "continue", { surface: "phone" })).rejects.toMatchObject({ status: 403 });
    await expect(w.integration.ownerAction(w.binding.bindingId, "continue", { surface: "desktop" })).rejects.toMatchObject({ status: 409, code: "not_handoff" });
    await expect(w.integration.ownerAction(w.binding.bindingId, "start", { surface: "phone" })).rejects.toMatchObject({ code: "not_stopped" });
  });
});
