// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CHIEF-TRANSFER-1023 W10 / W10b on the real Slack and Discord services with fake transports and their 1 s ticks running: after quiesce() a
// stale instance can never pause, unlink or overwrite a moving pairing, and retarget() + a fresh instance bound to the new Chief ends with one
// live transport and the owner still linked (revokeRuns, which unlinks, is never called).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackService } from "./slack/service.ts";
import type { SlackTransport } from "./slack/transport.ts";
import { DiscordService } from "./discord/service.ts";
import { WhatsAppService } from "./whatsapp/service.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roots: string[] = [], services: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => { for (const s of services.splice(0)) await s.stop().catch(() => undefined); for (const p of roots.splice(0)) removeTempDirSync(p); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

function slackWorld() {
  const dir = mkdtempSync(join(tmpdir(), "murage-ct-slack-")); roots.push(dir);
  let chief = "old", open = 0, opened = 0;
  const callbacks: Array<(raw: unknown, ack: () => Promise<void>) => void> = [];
  const revokeRuns = vi.fn(async () => {});
  const transport = (): SlackTransport => ({
    verifyBot: async () => ({ teamId: "TEAM", userId: "UBOT", botId: "BOT" }),
    sendText: async ({ dmId }) => ({ channel: dmId, ts: "1.2" }),
    stop: async () => { open = Math.max(0, open - 1); },
    start: async (cb, health) => { open++; opened++; callbacks.push(cb); health("connected"); },
  });
  const make = (target: string) => { const s = new SlackService({ dataDir: dir, chosen: { teamId: "TEAM", appId: "APP", ownerUserId: "UOWNER", chiefBotId: target },
    transport, isCurrentChief: id => chief === id, runs: () => ({ enqueue: () => ({ id: "run" }), result: () => ({ status: "completed", output: "ok" }) }), revokeRuns, now: () => 1000000000 }); services.push(s); return s; };
  let seq = 0;
  const raw = (text: string) => ({ type: "events_api", body: { type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: "Ev" + ++seq, event_time: 1000000,
    authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }], event: { type: "message", channel_type: "im", channel: "DOWNER", user: "UOWNER", text } } });
  const file = () => JSON.parse(readFileSync(join(dir, "channels", "slack", "connection.json"), "utf8")) as { paused: boolean; chosen: { chiefBotId: string }; binding: { chiefBotId: string } };
  const pairedOnOld = async () => {
    const service = make("old"); const p = await service.pair();
    callbacks.at(-1)!(raw("/pair " + p.code), async () => {}); await flush();
    return service;
  };
  return { dir, make, pairedOnOld, file, setChief: (id: string) => { chief = id; }, revokeRuns, open: () => open, opened: () => opened };
}

describe("W10 / W10b Slack", () => {
  it("W10b a moving Slack whose retarget is delayed past two ticks is never paused, unlinked or overwritten; the move ends with one live transport on the new Chief", async () => {
    const w = slackWorld();
    const old = await w.pairedOnOld();
    expect(w.file()).toMatchObject({ paused: false, chosen: { chiefBotId: "old" }, binding: { chiefBotId: "old" } });
    // the role is saved: another bot is Chief, and the sync prefix of the move runs
    w.setChief("new");
    old.quiesce?.();
    await sleep(2600);                              // more than two real 1 s ticks while moveTarget has not run yet
    await old.pause();                              // the store.onChange listener, if the hold ever missed it
    await flush();
    expect(w.file().paused).toBe(false);
    expect(w.revokeRuns).not.toHaveBeenCalled();
    // moveTarget: retire the old instance (runtime only), rewrite the file, build for the new Chief, resume
    await old.stop();
    old.retarget("new");
    expect(w.file()).toMatchObject({ paused: false, chosen: { chiefBotId: "new" }, binding: { chiefBotId: "new" } });
    const moved = w.make("new");
    await moved.resume(); await flush();
    // the receipt ledger is keyed by a digest of the binding (which names the Chief); a move that did not re-key it would block here
    expect(moved.status()).toMatchObject({ state: "connected", paired: true, enabled: true });
    expect(w.open()).toBe(1);
    expect(w.revokeRuns).not.toHaveBeenCalled();
    expect(w.file().paused).toBe(false);
  });

  it("W10 without a quiesce the old instance's own tick pauses the pairing and revokes (the write the hold exists to prevent)", async () => {
    const w = slackWorld();
    const old = await w.pairedOnOld();
    w.setChief("new");
    await sleep(1600);                              // the old instance's own 1 s tick fires
    await flush();
    expect(w.file().paused).toBe(true);
    expect(w.revokeRuns).toHaveBeenCalled();
    void old;
  });
});

describe("W10 Discord", () => {
  it("pause() is a no-op while moving and retarget() rewrites chosen and binding together, unpaused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-ct-discord-")); roots.push(dir);
    let chief = "old";
    const revokeRuns = vi.fn(async () => {});
    const callbacks: Array<(raw: unknown) => void> = [];
    const transport = () => ({ verifyBot: async () => ({ applicationId: "11", botUserId: "12" }), sendText: async () => ({ id: "m1" }), stop: async () => {},
      start: async (cb: (raw: unknown) => void, health: (s: "connected") => void) => { callbacks.push(cb); health("connected"); } });
    const service = new DiscordService({ dataDir: dir, chosen: { applicationId: "11", ownerUserId: "13", chiefBotId: "old" },
      transport: transport as never, isCurrentChief: (id: string) => chief === id, runs: () => ({ enqueue: () => ({ id: "r" }), result: () => ({ status: "completed", output: "ok" }) }), revokeRuns, now: () => 1000000000 } as never);
    services.push(service);
    const pairing = await service.pair();
    callbacks.at(-1)!({ applicationId: "11", botUserId: "12", id: "101", dmId: "14", channelType: 1, authorId: "13", authorBot: false, guildId: null, webhookId: null, type: 0,
      content: "/pair " + pairing.code, occurredAt: 1000000000, attachments: 0, components: 0, forwarded: false });
    await flush();
    chief = "new";
    service.quiesce?.();
    await service.pause();
    const read = () => JSON.parse(readFileSync(join(dir, "channels", "discord", "connection.json"), "utf8")) as { paused: boolean; chosen: { chiefBotId: string } };
    expect(read()).toMatchObject({ paused: false, chosen: { chiefBotId: "old" }, binding: { chiefBotId: "old" } });
    expect(revokeRuns).not.toHaveBeenCalled();
    service.retarget("new");
    expect(read()).toMatchObject({ paused: false, chosen: { chiefBotId: "new" } });
    expect(service.savedTarget()).toBe("new");
    // a fresh instance bound to the new Chief resumes against the same receipt ledger
    await service.stop();
    const moved = new DiscordService({ dataDir: dir, chosen: { applicationId: "11", ownerUserId: "13", chiefBotId: "new" },
      transport: transport as never, isCurrentChief: (id: string) => chief === id, runs: () => ({ enqueue: () => ({ id: "r" }), result: () => ({ status: "completed", output: "ok" }) }), revokeRuns, now: () => 1000000000 } as never);
    services.push(moved);
    await moved.resume(); await flush();
    expect(moved.status()).toMatchObject({ state: "connected", paired: true });
  });
});

describe("W10b WhatsApp", () => {
  it("pause() is a no-op while moving (no file write, no revokeRuns), and retarget() moves chiefBotId and binding.chiefBotId together, unpaused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-ct-whatsapp-")); roots.push(dir);
    const folder = join(dir, "channels", "whatsapp"); mkdirSync(folder, { recursive: true });
    const saved = { version: 1, chiefBotId: "old", enabled: true, paused: false, connectionId: "conn-1", pairing: [],
      binding: { connectionId: "conn-1", linkedPn: "15550001111@s.whatsapp.net", chiefBotId: "old" } };
    writeFileSync(join(folder, "connection.json"), JSON.stringify(saved));
    const revokeRuns = vi.fn(async () => {});
    const service = new WhatsAppService({ dataDir: dir, chosen: { chiefBotId: "old" }, settings: () => ({ mode: "self-chat", allowFrom: [], groups: { policy: "disabled", allow: [], senders: "members" }, readReceipts: false, quoteReplies: "off" }),
      transport: (() => { throw new Error("not started"); }) as never, authKey: { get: async () => "ef".repeat(32) } as never, isCurrentChief: () => false,
      people: {} as never, wipeData: async () => {}, revokeRuns, addAllowFrom: () => {}, runs: (() => ({})) as never } as never);
    services.push(service);
    const read = () => JSON.parse(readFileSync(join(folder, "connection.json"), "utf8")) as typeof saved;
    expect(read().chiefBotId).toBe("old");
    service.quiesce?.();
    await service.pause();                        // the listener / tick / receive self-pause, held off
    expect(read()).toMatchObject({ paused: false, chiefBotId: "old" });
    expect(revokeRuns).not.toHaveBeenCalled();
    service.retarget("new");
    expect(read()).toMatchObject({ paused: false, chiefBotId: "new", binding: { chiefBotId: "new" } });
    expect(service.savedTarget()).toBe("new");
    expect(service.savedConnectionId()).toBe("conn-1");
    service.endMove();
    await service.pause();                        // once the move is over a pause writes again
    expect(read().paused).toBe(true);
  });
});
