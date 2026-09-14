import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SlackService } from "./service.ts";
import type { SlackTransport } from "./transport.ts";
import { ChannelSendError } from "../durable-delivery.ts";
const roots: string[] = [], services: SlackService[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.stop(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-slack-service-")); roots.push(dir);
  const callbacks: Array<(raw: unknown, ack: () => Promise<void>) => void> = [], health: Array<(s: "connected" | "disconnected" | "error") => void> = [];
  let chief = true, id = 0;
  const retained = new Map<string, { id: string }>();
  const enqueue = vi.fn(({ deliveryId }: { deliveryId: string; prompt: string }) => { const r = retained.get(deliveryId) ?? { id: "run-" + deliveryId }; retained.set(deliveryId, r); return r; });
  const result = vi.fn(() => ({ status: "completed", output: "answer" }));
  const sendText = vi.fn(async ({ dmId }: { dmId: string; text: string; signal: AbortSignal }) => ({ channel: dmId, ts: "1.2" }));
  const verifyBot = vi.fn(async () => ({ teamId: "TEAM", userId: "UBOT", botId: "BOT" }));
  const stop = vi.fn(async () => {});
  const transport = vi.fn((): SlackTransport => ({ verifyBot, sendText, stop,
    start: async (cb, h) => { callbacks.push(cb); health.push(h); h("connected"); } }));
  const revokeRuns = vi.fn(async () => {});
  const options = { dataDir: dir, chosen: { teamId: "TEAM", appId: "APP", ownerUserId: "UOWNER", chiefBotId: "chief" },
    transport, isCurrentChief: () => chief, runs: () => ({ enqueue, result }), revokeRuns, now: () => 1000000000 };
  const service = new SlackService(options); services.push(service);
  const raw = (text: string, eventId = "Ev" + ++id) => ({ type: "events_api", body: { type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: eventId,
    event_time: 1000000, authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }],
    event: { type: "message", channel_type: "im", channel: "DOWNER", user: "UOWNER", text } } });
  const emit = async (event: unknown, ack = vi.fn(async () => {})) => { callbacks.at(-1)!(event, ack); await flush(); return ack; };
  const pair = async () => { const p = await service.pair(); await emit(raw("/pair " + p.code)); sendText.mockClear(); return p; };
  return { dir, options, service, pair, raw, emit, callbacks, health, enqueue, sendText, verifyBot, stop, revokeRuns, retained,
    invalidate: () => { chief = false; } };
}
it("requires the named owner challenge and durably accepts before ACK, not model completion", async () => {
  const f = fixture(), p = await f.service.pair();
  const bad = f.raw("/pair " + p.code); bad.body.event.user = "UOTHER"; await f.emit(bad);
  expect(f.service.status().paired).toBe(false); expect(f.enqueue).not.toHaveBeenCalled();
  await f.emit(f.raw("/pair " + p.code)); expect(f.service.status().paired).toBe(true); f.sendText.mockClear();
  const ack = vi.fn(async () => {
    const file = readdirSync(join(f.dir, "channels/slack")).find(n => n !== "connection.json")!;
    expect(readFileSync(join(f.dir, "channels/slack", file), "utf8")).toContain("EvREQUEST");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  await f.emit(f.raw("hello", "EvREQUEST"), ack);
  expect(ack).toHaveBeenCalledTimes(1); expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.sendText.mock.calls[0][0]).toMatchObject({ dmId: "DOWNER", text: "answer" });
});
it("ACK retry and overlapping duplicate envelopes retain one model run", async () => {
  const f = fixture(); await f.pair(); const e = f.raw("hello", "EvSAME");
  await f.emit(e, vi.fn(async () => { throw new Error("lost ack"); }));
  await f.emit(e); await f.emit(e); await f.service.tick();
  expect(f.enqueue).toHaveBeenCalledTimes(1); expect(f.sendText).toHaveBeenCalledTimes(1);
});
it("rejects wrong DM, all interactive approval authority and stopped callbacks", async () => {
  const f = fixture(); await f.pair();
  const e = f.raw("hello"); e.body.event.channel = "DOTHER"; await f.emit(e);
  await f.emit({ type: "interactive", body: { actions: [{ action_id: "allow", value: "expired" }] } });
  await f.emit(f.raw("yes")); expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.sendText.mock.calls[0][0].text).toContain("Review approvals in Murage");
  await f.service.revoke(); const count = f.sendText.mock.calls.length; await f.emit(f.raw("after revoke"));
  expect(f.sendText).toHaveBeenCalledTimes(count); expect(f.revokeRuns).toHaveBeenCalledTimes(1);
});
it("resumes the exact saved identity; Chief changes pause instead of rerouting", async () => {
  const f = fixture(); await f.pair(); await f.service.stop();
  const restarted = new SlackService(f.options); services.push(restarted); await restarted.resume();
  expect(restarted.status()).toMatchObject({ paired: true, enabled: true });
  f.invalidate(); await restarted.tick(); expect(restarted.status()).toMatchObject({ state: "blocked", enabled: false, error: "chief-changed" });
  expect(f.revokeRuns).toHaveBeenCalledTimes(1);
  const disk = JSON.parse(readFileSync(join(f.dir, "channels/slack/connection.json"), "utf8")); expect(disk.paused).toBe(true);
});
it("identity mismatch blocks saved pairing without sending or overwriting", async () => {
  const f = fixture(); await f.pair(); await f.service.stop();
  f.verifyBot.mockResolvedValue({ teamId: "OTHER", userId: "UBOT", botId: "BOT" });
  const restarted = new SlackService(f.options); services.push(restarted); await restarted.resume();
  expect(restarted.status()).toMatchObject({ state: "blocked", error: "identity-mismatch" }); expect(f.sendText).not.toHaveBeenCalled();
});
it("offline startup retries once per bounded clock deadline without model work", async () => {
  const f = fixture(); await f.pair(); await f.service.stop(); vi.useFakeTimers();
  f.verifyBot.mockRejectedValueOnce(new ChannelSendError("offline", false)); f.verifyBot.mockClear();
  const restarted = new SlackService(f.options); services.push(restarted); await restarted.resume();
  expect(restarted.status().state).toBe("retry"); expect(f.verifyBot).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1999); expect(f.verifyBot).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.verifyBot).toHaveBeenCalledTimes(2); expect(restarted.status().enabled).toBe(true);
});
it("rejects persisted binding fields inconsistent with the chosen app/owner/Chief", async () => {
  const f = fixture(); await f.pair(); await f.service.stop();
  const file = join(f.dir, "channels/slack/connection.json"), saved = JSON.parse(readFileSync(file, "utf8"));
  saved.binding.chiefBotId = "other-chief"; writeFileSync(file, JSON.stringify(saved));
  const restarted = new SlackService(f.options); services.push(restarted); await restarted.resume();
  expect(restarted.status()).toMatchObject({ state: "blocked", enabled: false });
  expect(f.sendText).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});
it("revoke still cancels bound runs if the connection file cannot be written", async () => {
  const f = fixture(); await f.pair();
  const file = join(f.dir, "channels/slack/connection.json"); renameSync(file, file + ".original"); mkdirSync(file);
  await expect(f.service.revoke()).rejects.toThrow("needs recovery");
  expect(f.revokeRuns).toHaveBeenCalledTimes(1); expect(f.service.status()).toMatchObject({ enabled: false, state: "blocked" });
  await f.emit(f.raw("do not dispatch")); expect(f.enqueue).not.toHaveBeenCalled();
});
it("temporary disconnect keeps the saved binding authoritative but blocks transport sends", async () => {
  const f = fixture(); await f.pair();
  const saved = JSON.parse(readFileSync(join(f.dir, "channels/slack/connection.json"), "utf8"));
  f.health.at(-1)!("disconnected"); expect(f.service.isCurrent(saved.binding)).toBe(true);
  await f.service.tick(); expect(f.sendText).not.toHaveBeenCalled();
  await f.service.stop(); expect(f.service.isCurrent(saved.binding)).toBe(false);
});
