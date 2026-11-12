// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// BOT-CALLS-1020 item 5: the owner routes answer the desktop app only, report key-present but never the key, list the older-settings
// scheduled calls, and the Ask card line carries the resolved language and revision. A fake adapter only: no real calls.
import { afterEach, expect, it, vi } from "vitest";
import { phoneAskLine, setPhoneAskPreview } from "../drivers/phone-tool-schemas.ts";
import { phoneOwnerRoute, parseOwnerSettings } from "./owner-routes.ts";
import { PHONE_SECRETS_ENV, _resetPhoneSecretsForTest, loadPhoneSecretsFromEnv } from "./phone-secrets.ts";
import { MemoryCallStore, PhoneCallService } from "./service.ts";
import { RevisionStore, defaultSettings } from "./settings.ts";
import { ALL_SETTINGS, type PhoneAdapter } from "./vapi-adapter.ts";

const KEY = "fake-key-SECRET-7731";
const desktopWithKey = () => loadPhoneSecretsFromEnv({ [PHONE_SECRETS_ENV]: JSON.stringify({ key: KEY, origin: "https://api.vapi.ai" }) });
let n = 0;
const adapter = {
  vendor: "vapi", supportedLanguages: ["en", "de"], capabilities: Object.fromEntries(ALL_SETTINGS.map((k) => [k, true])),
  setup: async () => ({ numbers: [{ id: "num-1", number: "+15550100", canCallOut: true }] }),
  applySettings: async () => `asst-${++n}`, deleteAssistant: async () => {}, cancel: async () => {},
} as unknown as PhoneAdapter;
const make = () => new PhoneCallService(adapter, new RevisionStore(), () => "en", () => {}, new MemoryCallStore());
const ask = (svc: PhoneCallService, method: string, path: string, body?: unknown, desktop = true, botCredential = false) =>
  phoneOwnerRoute(() => svc, { method, path, body, desktop, botCredential });

afterEach(() => { _resetPhoneSecretsForTest(); setPhoneAskPreview(null); vi.useRealTimers(); });

it("anyone but the desktop app, and any bot credential, gets 404; other paths are not ours", async () => {
  desktopWithKey();
  const svc = make();
  expect((await ask(svc, "GET", "/api/phone-calls/status", undefined, false))?.status).toBe(404);
  expect((await ask(svc, "GET", "/api/phone-calls/status", undefined, true, true))?.status).toBe(404);
  expect(await ask(svc, "GET", "/api/phone-callsX")).toBeNull();
});

it("status reports key-present only, never the key", async () => {
  const svc = make();
  expect((await ask(svc, "GET", "/api/phone-calls/status"))?.body).toMatchObject({ supported: false, keyPresent: false });
  desktopWithKey();
  const answer = await ask(svc, "GET", "/api/phone-calls/status");
  expect(answer?.body).toMatchObject({ supported: true, keyPresent: true, active: null });
  expect(JSON.stringify(answer)).not.toContain(KEY);
});

it("setup reads numbers, settings save a revision, older scheduled calls are listed, and the Ask line shows language and revision", async () => {
  desktopWithKey();
  const svc = make();
  expect((await ask(svc, "POST", "/api/phone-calls/setup"))?.body).toEqual({ numbers: [{ id: "num-1", number: "+15550100", canCallOut: true }] });
  const settings = defaultSettings("num-1", "Sean");
  expect(parseOwnerSettings({ ...settings, maxSeconds: 5 })).toBeNull();
  expect((await ask(svc, "PUT", "/api/phone-calls/settings", { ...settings, language: "xx" }))?.status).toBe(400);
  expect((await ask(svc, "PUT", "/api/phone-calls/settings", settings))?.body).toEqual({ revision: 1 });
  (svc as unknown as { rows: MemoryCallStore }).rows.put({ id: "c-old", vendorId: "v-old", revision: 1, assistantId: "asst-1", createdAt: 1, status: "scheduled", language: "en", to: "+15550199", goal: "g", details: "", limits: "", when: "2026-11-09T10:00:00Z" });
  expect((await ask(svc, "PUT", "/api/phone-calls/settings", { ...settings, recordAudio: true }))?.body).toEqual({ revision: 2 });
  const status = await ask(svc, "GET", "/api/phone-calls/status");
  expect(status?.body.olderScheduled).toEqual([{ id: "c-old", revision: 1, to: "+15550199", when: "2026-11-09T10:00:00Z" }]);
  expect((await ask(svc, "POST", "/api/phone-calls/c-old/cancel"))?.body).toEqual({ status: "cancelled" });
  expect((await ask(svc, "GET", "/api/phone-calls/status"))?.body.olderScheduled).toEqual([]);

  setPhoneAskPreview((args) => svc.askPreview(args));
  const line = phoneAskLine("mcp__agents__phone_call_place", { to: "+15550100", goal: "Book a table", details: "", limits: "No deposit" });
  expect(line).toContain("Language: en");
  expect(line).toContain("Settings revision 2");
  expect(phoneAskLine("mcp__agents__phone_call_result", { id: "x" })).toBeNull();
});

it("owner Cancel reports abandonment and a later list refresh cancels the identified call once", async () => {
  desktopWithKey();
  const rows = new MemoryCallStore();
  rows.put({ id: "lost", vendorId: "", revision: 1, assistantId: "a", createdAt: 1,
    status: "uncertain", language: "en", to: "+15550123456", goal: "book", details: "", limits: "" });
  let found = false;
  const deleted: string[] = [];
  const svc = new PhoneCallService({
    ...adapter,
    reconcile: async id => { expect(id).toBe("lost"); return found ? { vendorId: "identified", status: "scheduled" } : undefined; },
    cancel: async id => { deleted.push(id); },
  }, new RevisionStore(), () => "en", () => {}, rows);
  expect(await ask(svc, "POST", "/api/phone-calls/lost/cancel")).toEqual({ status: 200, body: { status: "abandoned" } });
  expect(deleted).toEqual([]);
  found = true;
  expect(await ask(svc, "GET", "/api/phone-calls")).toMatchObject({ body: { calls: [{ status: "abandoned" }] } });
  await ask(svc, "GET", "/api/phone-calls");
  expect(deleted).toEqual(["identified"]);
  expect(rows.get("lost")?.abandonCancel).toBe("confirmed");
});

function lifecycleFixture() {
  desktopWithKey();
  const rows = new MemoryCallStore();
  const result = vi.fn(async (vendorId: string) => ({ vendorId, status: "ended", transcript: "Table booked.", structured: { outcome: "done" } }));
  const start = vi.fn(async () => ({ vendorId: "new-call", status: "ringing" }));
  const svc = new PhoneCallService({ ...adapter, result, start }, new RevisionStore(), () => "en", () => {}, rows);
  rows.put({ id: "ordinary", vendorId: "vendor-call", revision: 1, assistantId: "a", createdAt: 1,
    status: "ringing", language: "en", to: "+15550123456", goal: "Book", details: "", limits: "" });
  return { rows, result, start, svc };
}

it("owner GET refreshes ordinary calls to completion without an engine request or another create", async () => {
  const f = lifecycleFixture();
  expect(await ask(f.svc, "GET", "/api/phone-calls")).toMatchObject({ body: { calls: [
    { id: "ordinary", status: "ended", outcome: "done", transcript: "Table booked." },
  ] } });
  expect(f.result).toHaveBeenCalledWith("vendor-call");
  await ask(f.svc, "GET", "/api/phone-calls");
  expect(f.result).toHaveBeenCalledTimes(1);
  expect(f.start).not.toHaveBeenCalled();
});

it.each([[false, false], [true, true], [false, true]])("denied owner GET (%s, %s) never reads vendor data or a transcript", async (desktop, botCredential) => {
  const f = lifecycleFixture();
  const service = vi.fn(() => f.svc);
  expect(await phoneOwnerRoute(service, { method: "GET", path: "/api/phone-calls", desktop, botCredential })).toEqual({ status: 404, body: { error: "no such route" } });
  expect(service).not.toHaveBeenCalled();
  expect(f.result).not.toHaveBeenCalled();
});

it.each(["cancelled", "ended", "abandoned"] as const)("late owner refresh cannot reopen %s", async status => {
  const f = lifecycleFixture();
  let answer!: (value: Awaited<ReturnType<typeof f.result>>) => void;
  f.result.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const pending = ask(f.svc, "GET", "/api/phone-calls");
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1));
  f.rows.put({ ...f.rows.get("ordinary")!, status });
  answer({ vendorId: "vendor-call", status: "ringing", transcript: "", structured: {} as { outcome: string } });
  expect(await pending).toMatchObject({ body: { calls: [{ status }] } });
});

it("concurrent owner reads share refresh work and a failed read leaves the cached card available", async () => {
  const f = lifecycleFixture();
  let fail!: (reason: Error) => void;
  f.result.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const first = ask(f.svc, "GET", "/api/phone-calls");
  const second = ask(f.svc, "GET", "/api/phone-calls");
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1));
  fail(new Error("offline"));
  for (const response of await Promise.all([first, second])) expect(response).toMatchObject({ body: { calls: [{ status: "ringing" }] } });
  expect(await ask(f.svc, "GET", "/api/phone-calls")).toMatchObject({ body: { calls: [{ status: "ended" }] } });
});

it("owner refresh enriches an ended card when vendor analysis and transcript arrive later", async () => {
  const f = lifecycleFixture();
  f.result.mockResolvedValueOnce({ vendorId: "vendor-call", status: "ended", transcript: "", structured: {} as { outcome: string } });
  expect(await ask(f.svc, "GET", "/api/phone-calls")).toMatchObject({ body: { calls: [{ status: "ended" }] } });
  expect(await ask(f.svc, "GET", "/api/phone-calls")).toMatchObject({ body: { calls: [{ status: "ended", outcome: "done", transcript: "Table booked." }] } });
  expect(f.result).toHaveBeenCalledTimes(2);
  await ask(f.svc, "GET", "/api/phone-calls");
  expect(f.result).toHaveBeenCalledTimes(2);
});

it("owner refresh bounds its displayed rows and vendor concurrency", async () => {
  const f = lifecycleFixture();
  for (let i = 0; i < 60; i++) f.rows.put({ ...f.rows.get("ordinary")!, id: `call-${i}`, vendorId: `vendor-${i}`, createdAt: i + 2 });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.result.mockImplementation(async vendorId => { await pending; return { vendorId, status: "ended", transcript: "Done", structured: { outcome: "done" } }; });
  const response = ask(f.svc, "GET", "/api/phone-calls");
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(4));
  release();
  const answer = await response;
  expect(answer?.body.calls).toHaveLength(50);
  expect(f.result).toHaveBeenCalledTimes(50);
  expect(f.rows.get("ordinary")?.status).toBe("ringing");
  expect(f.rows.get("call-0")?.status).toBe("ringing");
});


it("stalled owner reads return cached cards by the application deadline and a later poll recovers", async () => {
  vi.useFakeTimers();
  const f = lifecycleFixture();
  // Never settles: neither a network error nor the adapter's transport can rescue this read.
  f.result.mockImplementationOnce(() => new Promise(() => {}));
  const answers: unknown[] = [];
  const first = ask(f.svc, "GET", "/api/phone-calls").then(answer => { answers.push(answer); });
  await vi.advanceTimersByTimeAsync(1);
  const remount = ask(f.svc, "GET", "/api/phone-calls").then(answer => { answers.push(answer); });
  expect(f.result).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(answers).toHaveLength(2);
  expect(answers).toEqual(Array(2).fill(expect.objectContaining({ body: { calls: [expect.objectContaining({ id: "ordinary", status: "ringing" })] } })));
  await Promise.all([first, remount]);
  expect(await ask(f.svc, "GET", "/api/phone-calls")).toMatchObject({ body: { calls: [{ status: "ended", transcript: "Table booked." }] } });
  expect(f.result).toHaveBeenCalledTimes(2);
  expect(f.start).not.toHaveBeenCalled();
});

it("an expired owner pass ignores late results and stops its queued vendor reads", async () => {
  vi.useFakeTimers();
  const f = lifecycleFixture();
  for (let i = 0; i < 5; i++) f.rows.put({ ...f.rows.get("ordinary")!, id: `queued-${i}`, createdAt: i + 2 });
  let settle!: (value: Awaited<ReturnType<typeof f.result>>) => void;
  const stale = new Promise<Awaited<ReturnType<typeof f.result>>>(resolve => { settle = resolve; });
  f.result.mockImplementation(() => stale);
  let answered = false;
  const read = ask(f.svc, "GET", "/api/phone-calls").then(() => { answered = true; });
  await vi.advanceTimersByTimeAsync(2000);
  expect(answered).toBe(true);
  await read;
  expect(f.result).toHaveBeenCalledTimes(4);
  f.result.mockResolvedValue({ vendorId: "vendor-call", status: "ended", transcript: "New analysis", structured: { outcome: "done" } });
  await ask(f.svc, "GET", "/api/phone-calls");
  settle({ vendorId: "vendor-call", status: "ended", transcript: "Stale analysis", structured: { outcome: "failed" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.result).toHaveBeenCalledTimes(10);
  expect(f.rows.recent().every(row => row.transcript === "New analysis" && row.structured?.outcome === "done")).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});


it.each(["uncertain", "abandoned", "abandon-delete", "cleanup", "terminal-cleanup"] as const)(
  "the owner deadline also bounds stalled %s I/O and ignores its late answer", async stall => {
    vi.useFakeTimers();
    const f = lifecycleFixture();
    const revisions = new RevisionStore();
    revisions.confirm(revisions.save(defaultSettings("n", "Owner")).number, "old");
    revisions.confirm(revisions.save(defaultSettings("n", "Owner")).number, "current");
    const forget = vi.spyOn(revisions, "forget");
    let settle!: (value?: unknown) => void;
    const delayed = new Promise<unknown>(resolve => { settle = resolve; });
    const reconcile = vi.fn().mockResolvedValue({ vendorId: "found", status: "ended", transcript: "Recovered", structured: { outcome: "done" } });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const row = f.rows.get("ordinary")!;
    if (stall === "uncertain" || stall === "abandoned") {
      f.rows.put({ ...row, vendorId: "", status: stall });
      reconcile.mockReturnValueOnce(delayed);
    } else if (stall === "abandon-delete") {
      f.rows.put({ ...row, status: "abandoned" });
      cancel.mockReturnValueOnce(delayed);
    } else {
      if (stall === "cleanup") {
        f.rows.put({ ...row, revision: 2 });
        f.result.mockResolvedValue({ vendorId: "vendor-call", status: "ringing", transcript: "", structured: { outcome: "" } });
      }
      remove.mockReturnValueOnce(delayed).mockRejectedValueOnce(new Error("retry offline"));
    }
    const svc = new PhoneCallService({ ...adapter, result: f.result, reconcile, cancel, deleteAssistant: remove }, revisions, () => "en", () => {}, f.rows);
    let answer: unknown;
    const read = ask(svc, "GET", "/api/phone-calls").then(value => { answer = value; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(answer).toMatchObject({ status: 200, body: { calls: [{ id: "ordinary" }] } });
    await read;
    const recovered = await ask(svc, "GET", "/api/phone-calls");
    if (stall === "uncertain") expect(recovered).toMatchObject({ body: { calls: [{ status: "ended", transcript: "Recovered" }] } });
    if (stall === "abandon-delete") expect(f.rows.get("ordinary")?.abandonCancel).toBe("attempted");
    const state = f.rows.get("ordinary");
    const forgets = forget.mock.calls.length;
    settle({ vendorId: "stale", status: "ringing", transcript: "Stale" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.rows.get("ordinary")).toEqual(state);
    expect(forget).toHaveBeenCalledTimes(forgets);
    if (stall === "abandon-delete") expect(cancel).toHaveBeenCalledTimes(1);
    if (stall === "cleanup" || stall === "terminal-cleanup") {
      expect(revisions.get(1)).toBeDefined();
      await ask(svc, "GET", "/api/phone-calls");
      expect(revisions.get(1)).toBeUndefined();
      expect(remove).toHaveBeenCalledTimes(3);
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);
