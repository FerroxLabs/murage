// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 Rule 81 over real HTTP: the server owns the grant set. A decision
// names its pending request; the server rereads THAT card's stored offer and
// saves the whole set or none of it, from the desktop or the paired phone,
// and never from anyone else. Rule 78c on the bot route: a card of several
// actions is remembered as its whole set, never sliced.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
// The cards are seeded on disk (the shape the request.opened fold writes),
// so this is about the grant routes, not about a turn.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApprovalGrantRequest } from "../shared/approval-grant-request.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
const LAUNCH_PROOF = randomBytes(32).toString("hex");

const THREAD = "a13-thread";
const SET_THREAD = "a13-set-thread";
const ROUTINE = "a13-routine";
const OTHER_ROUTINE = "a13-other";
const IDLE_ROUTINE = "a13-idle";
const ACTIONS = ["app-action:GMAIL_FETCH_EMAILS", "app-action:GOOGLECALENDAR_EVENTS_LIST", "app-action:GOOGLECALENDAR_CREATE_EVENT", "app-action:GMAIL_CREATE_EMAIL_DRAFT"];
const LOOKUP = "mcp__murage_connectors__APPS_SEARCH_TOOLS";
const BOB = "stop:message:bob@example.com";

let base: string;
let child: ChildProcess;
let home: string;
let stderr = "";
let desktopHeaders: Record<string, string>;

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const desktop = (path: string, body: unknown) => request("POST", path, body, desktopHeaders);
const phone = (path: string, body: unknown) => request("POST", path, body, { "x-murage-companion-token": LAUNCH_PROOF });
const storedRoutine = (id: string) => (JSON.parse(readFileSync(join(home, ".murage", "routines.json"), "utf8")).routines as Array<{ id: string; alwaysAllow?: string[] }>).find((routine) => routine.id === id)!;
const storedBot = (id: string) => (JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")) as Array<{ id: string; alwaysAllow?: string[] }>).find((bot) => bot.id === id)!;

const offer = (routineId: string, extra: Partial<NonNullable<ApprovalGrantRequest["routine"]>> = {}): ApprovalGrantRequest => ({
  rows: [],
  routine: { routineId, routineName: "Training", eligible: true, actionKeys: [...ACTIONS, LOOKUP], stopKeys: [{ key: BOB, what: "Message someone it has not written to before: bob@example.com", recipient: "bob@example.com" }], notRemembered: [], ...extra },
});
const card = (id: string, extra: Record<string, unknown>) => ({
  id, at: 3, parentId: null, role: "bot", kind: "options", from: { botId: "a13-bot", name: "Dax", color: "purple" },
  card: { title: "Approval needed", subtitle: "Run app tools", options: ["Allow", "Deny"], requestId: `${id}-request`, tool: "other", ...extra },
});
const routineRow = (id: string, alwaysAllow?: string[]) => ({
  id, name: id === ROUTINE ? "Training" : "Other", prompt: "Prepare", botId: "a13-bot", target: "bot", runOn: "ember", enabled: false,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: 1, createdAt: 1, updatedAt: 1, permissionMode: "ask",
  ...(alwaysAllow ? { alwaysAllow } : {}),
});
const bot = (id: string, threadId: string) => ({
  id, threadId, name: "Dax", title: "", description: "", notifications: true, color: "blue", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, resumeCursors: {}, createdAt: 1,
});

posixOnly("AMEND-13 Rule 81: the grant routes", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "murage-a13-grants-"));
    const data = join(home, ".murage");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
    writeFileSync(join(data, "bots.json"), JSON.stringify([bot("a13-bot", THREAD), bot("a13-set-bot", SET_THREAD)]));
    // the other routine is one filler key short of the cap
    const filler = Array.from({ length: 199 }, (_, i) => `stop:message:p${i}@example.com`);
    writeFileSync(join(data, "routines.json"), JSON.stringify({ version: 1, routines: [routineRow(ROUTINE), routineRow(OTHER_ROUTINE, filler), routineRow(IDLE_ROUTINE)], runs: [] }));
    writeFileSync(join(data, `messages-${THREAD}.json`), JSON.stringify({
      activeLeafId: "full",
      messages: [
        card("open", { routineId: ROUTINE, grantRequest: offer(ROUTINE) }),
        card("answered", { routineId: ROUTINE, grantRequest: offer(ROUTINE), answered: "allow" }),
        card("dismissed", { routineId: ROUTINE, grantRequest: offer(ROUTINE), dismissed: true }),
        card("other", { routineId: OTHER_ROUTINE, grantRequest: offer(OTHER_ROUTINE) }),
        card("closed", { routineId: ROUTINE, grantRequest: offer(ROUTINE, { eligible: false, reason: "This controls your computer, so Murage asks every time.", actionKeys: [], stopKeys: [] }) }),
        card("full", { routineId: OTHER_ROUTINE, grantRequest: offer(OTHER_ROUTINE, { actionKeys: ACTIONS.slice(0, 2), stopKeys: [] }) }),
        card("idle", { routineId: IDLE_ROUTINE, grantRequest: offer(IDLE_ROUTINE) }),
        card("idle-answered", { routineId: IDLE_ROUTINE, grantRequest: offer(IDLE_ROUTINE), answered: "deny" }),
      ].map((message, index, all) => ({ ...message, parentId: index ? all[index - 1]!.id : null })),
    }));
    writeFileSync(join(data, `messages-${SET_THREAD}.json`), JSON.stringify({
      activeLeafId: "set",
      messages: [{ ...card("set", { allowKeys: ACTIONS }), from: { botId: "a13-set-bot", name: "Dax", color: "purple" } }],
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_COMPANION_TOKEN: LAUNCH_PROOF,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await request("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  const route = `/api/routines/${ROUTINE}/always-allow`;

  it("refuses a decision that names no request, or a stale, wrong-routine or ineligible card", async () => {
    expect((await desktop(route, { answer: true, threadId: THREAD })).status).toBe(400);
    for (const id of ["answered", "dismissed", "other", "missing"]) expect((await desktop(route, { answer: true, threadId: THREAD, requestId: `${id}-request` })).status, id).toBe(409);
    const closed = await desktop(route, { answer: true, threadId: THREAD, requestId: "closed-request" });
    expect(closed.status).toBe(409);
    expect(closed.body.error).toMatch(/controls your computer/);
    expect(storedRoutine(ROUTINE).alwaysAllow ?? []).toEqual([]);
  });

  it("never takes a key the card did not offer", async () => {
    expect((await desktop(route, { answer: true, threadId: THREAD, requestId: "open-request", allowKey: "app-action:SLACK_SEND_MESSAGE" })).status).toBe(409);
    expect((await desktop(route, { answer: true, threadId: THREAD, requestId: "open-request", stopKeys: ["stop:message:eve@example.com"] })).status).toBe(409);
    expect((await desktop(route, { answer: true, threadId: THREAD, requestId: "open-request", stopKeys: "all" })).status).toBe(400);
    expect(storedRoutine(ROUTINE).alwaysAllow ?? []).toEqual([]);
  });

  it("gives nobody but the owner's desktop or paired phone grant-writing authority", async () => {
    expect((await request("POST", route, { answer: true, threadId: THREAD, requestId: "open-request" })).status).toBe(404);
    expect((await request("POST", route, { answer: true, threadId: THREAD, requestId: "open-request" }, { "x-murage-companion-token": "f".repeat(64) })).status).toBe(404);
    expect(storedRoutine(ROUTINE).alwaysAllow ?? []).toEqual([]);
  });

  it("asks the paired phone for the same fresh check an Allow gets before it saves anything", async () => {
    // Rule 81d: same server checks; this card is not rated low, and the phone sent no proof
    const refused = await phone(route, { answer: true, threadId: THREAD, requestId: "open-request" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toMatch(/^(fresh_auth|fresh_auth_unattested|approve_on_computer|fresh_auth_unavailable)$/);
    expect(storedRoutine(ROUTINE).alwaysAllow ?? []).toEqual([]);
  });

  it("Rule 81b: one decision saves and answers together, and saves nothing when the request is no longer waiting or is settled", async () => {
    const idle = `/api/routines/${IDLE_ROUTINE}/always-allow`;
    // no engine holds this request any more: nothing is saved
    const gone = await desktop(idle, { threadId: THREAD, requestId: "idle-request", answer: true });
    expect(gone.status, JSON.stringify(gone.body)).toBe(409);
    // a settled answer is never widened by a later remembered choice
    const settled = await desktop(idle, { threadId: THREAD, requestId: "idle-answered-request", answer: true });
    expect(settled.status).toBe(409);
    expect(storedRoutine(IDLE_ROUTINE).alwaysAllow ?? []).toEqual([]);
  });

  it("Rule 81a (Astra a13 r1 item 4): saves nothing from a card no engine still holds, with or without answer", async () => {
    // an orphaned pending card: the server rereads the live request whatever the flag says
    // A13-FIX-DESIGN C1: without its approving answer nothing is even considered
    for (const body of [{}, { answer: false }, { stopKeys: [BOB] }]) {
      const refused = await desktop(route, { threadId: THREAD, requestId: "open-request", ...body });
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    for (const body of [{ answer: true }, { answer: true, stopKeys: [BOB] }]) {
      const orphan = await desktop(route, { threadId: THREAD, requestId: "open-request", ...body });
      expect(orphan.status, JSON.stringify(body)).toBe(409);
      expect(orphan.body.error).toBe("This request is no longer waiting.");
    }
    expect(storedRoutine(ROUTINE).alwaysAllow ?? []).toEqual([]);
  });

  it("saves none of a set that would pass the cap", async () => {
    const full = await desktop(`/api/routines/${OTHER_ROUTINE}/always-allow`, { answer: true, threadId: THREAD, requestId: "full-request" });
    expect(full.status).toBe(409);
    expect(storedRoutine(OTHER_ROUTINE).alwaysAllow).toHaveLength(199);
    expect(storedRoutine(OTHER_ROUTINE).alwaysAllow).not.toContain(ACTIONS[0]);
  });

  it("Rule 81b (Astra a13 r1 item 5): a remembered choice that answers too saves nothing from a card no engine still holds", async () => {
    const orphan = await desktop("/api/bots/a13-set-bot/always-allow", { allowKeys: ACTIONS, threadId: SET_THREAD, requestId: "set-request", answer: true });
    expect(orphan.status, JSON.stringify(orphan.body)).toBe(409);
    expect(orphan.body.error).toBe("This request is no longer waiting.");
    expect(storedBot("a13-set-bot").alwaysAllow ?? []).toEqual([]);
  });

  it("matches a several-action card's whole set, never one key of it, and saves it only from a live request", async () => {
    const partial = await desktop("/api/bots/a13-set-bot/always-allow", { answer: true, allowKeys: ACTIONS.slice(0, 1), threadId: SET_THREAD, requestId: "set-request" });
    expect(partial.status).toBe(409);
    expect((await desktop("/api/bots/a13-set-bot/always-allow", { answer: true, allowKey: ACTIONS[0], threadId: SET_THREAD, requestId: "set-request" })).status).toBe(409);
    expect((await desktop("/api/bots/a13-set-bot/always-allow", { answer: true, allowKeys: ACTIONS, threadId: SET_THREAD })).status).toBe(400);
    expect(storedBot("a13-set-bot").alwaysAllow ?? []).toEqual([]);
    // The whole set, in any order, matches the card's offer (Rule 78c): it is
    // refused only because no engine still holds this seeded card. Rule 81a
    // (Astra a13 r1 item 4): every save, with or without `answer`, rereads the
    // live request, so an orphaned card saves nothing.
    const whole = await desktop("/api/bots/a13-set-bot/always-allow", { answer: true, allowKeys: [...ACTIONS].reverse(), threadId: SET_THREAD, requestId: "set-request" });
    expect(whole.status, JSON.stringify(whole.body)).toBe(409);
    expect(whole.body.error).toBe("This request is no longer waiting.");
    expect(storedBot("a13-set-bot").alwaysAllow ?? []).toEqual([]);
  });
});
