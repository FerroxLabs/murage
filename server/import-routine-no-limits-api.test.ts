// SPDX-License-Identifier: AGPL-3.0-or-later
// Import/fixture owner: nl-import-routine. Runtime inheritance owner: gnl-inherit.
// The documented launcher owns an isolated home and a fake native engine.
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import { applyRoutinePermissionMode, effectiveRoutinePermissionMode } from "./routine-permissions.ts";
import { autoVerdict } from "./auto-approve.ts";

let fixture: VerificationServer;
let desktop: Record<string, string>;
async function api(method: string, path: string, body?: unknown, headers = desktop) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
async function authenticate() {
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret", undefined, {})).body.secret };
}
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { dumpLog: true });
  await authenticate();
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
}, 120_000);
afterAll(async () => { await fixture?.close(); });

function definition() {
  return parseBotPackage({ format: "murage.package", version: 1, package: {
    id: "routine-fixture", release: "1.0.0", name: "Routine fixture", tagline: "Routine import fixture",
    summary: "Definition only", category: "Work", author: { name: "Fixture" }, license: "MIT",
    outcomes: ["Report status"], setupMinutes: 1, requirements: { apps: [], capabilities: [] },
    agents: [{ key: "member", name: "Routine member", role: "member", appearance: { color: "green" } }],
    routines: [{ key: "daily", name: "Import routine", agent: "member", prompt: "__fixture_permission_tool__", runOn: "ember",
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 }, durationMinutes: 15, enabledAfterInstall: false }],
  } });
}
const listing = async () => (await api("GET", "/api/routines")).body;
async function routineById(id: string) { return (await listing()).routines.find((row: any) => row.id === id); }
async function profile(id: string) { return (await api("GET", `/api/bots/${id}`)).body.bot; }
function verdict(routine: any, bot: any) {
  return autoVerdict(applyRoutinePermissionMode(bot, effectiveRoutinePermissionMode(routine, bot)), "Bash", "echo routine", { automated: true, routineLevel: true });
}

for (const format of ["team", "Markdown"] as const) {
  it.each(["ask", "no-limits"] as const)(`${format} routine at %s keeps its owner level on enable and reload`, async level => {
    expect((await api("PATCH", "/api/config", { newBots: { permissionLevel: level }, ...(level === "no-limits" ? { acknowledgeNoLimits: true } : {}) })).status).toBe(200);
    const document = definition();
    // Legacy murage.team files install people only; the team endpoint also
    // accepts full package definitions and their Markdown representation.
    const imported = await api("POST", "/api/teams/import", format === "Markdown" ? renderBotPackageMarkdown(document) : document);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const botId = imported.body.bots[0].id;
    const routine = (await listing()).routines.find((row: any) => row.botId === botId);
    expect(routine).toMatchObject({ enabled: false, nextRunAt: null });
    expect(routine.permissionExplicit).not.toBe(true);
    expect((await api("PATCH", `/api/routines/${routine.id}`, { enabled: true })).status).toBe(200);
    for (const reload of [false, true]) {
      if (reload) { await fixture.restart(); await authenticate(); }
      const current = await routineById(routine.id);
      expect(current.enabled).toBe(true);
      expect(current.permissionExplicit).not.toBe(true);
      expect(verdict(current, await profile(botId))).toMatchObject(level === "no-limits"
        ? { source: "no-limits", approve: expect.any(String) } : { source: "no-grant", approve: null });
      if (level === "no-limits") {
        const started = await api("POST", `/api/routines/${routine.id}/run`, {});
        expect(started.status).toBe(201);
        let threadId: string;
        await expect.poll(async () => {
          threadId = (await listing()).runs.find((row: any) => row.id === started.body.run.id)?.threadId;
          if (!threadId) return false;
          const rows = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages;
          return rows.some((row: any) => row.text === "permission: allowed");
        }, { timeout: 30_000 }).toBe(true);
        const rows = (await api("GET", `/api/threads/${threadId!}/messages?limit=100`)).body.messages;
        expect(rows.filter((row: any) => row.card?.requestHandle)).toHaveLength(0);
        await expect.poll(async () => (await listing()).runs.find((row: any) => row.id === started.body.run.id)?.status, { timeout: 30_000 }).toBe("completed");
      }
    }
    // The owner can choose a lower routine ceiling even in a No limits home.
    expect((await api("PATCH", `/api/routines/${routine.id}`, { permissionMode: "ask" })).status).toBe(200);
    await fixture.restart(); await authenticate();
    const explicit = await routineById(routine.id);
    expect(explicit).toMatchObject({ permissionMode: "ask", permissionExplicit: true });
    expect(verdict(explicit, await profile(botId))).toMatchObject({ source: "no-grant", approve: null });
  }, 120_000);
}

it("a guest-origin import cannot install a routine or acquire the home's No limits", async () => {
  expect((await api("PATCH", "/api/config", { newBots: { permissionLevel: "no-limits" }, acknowledgeNoLimits: true })).status).toBe(200);
  const before = (await listing()).routines.map((row: any) => row.id);
  const imported = await api("POST", "/api/teams/import", definition(), { origin: "https://guest.example.test" });
  expect([401, 403]).toContain(imported.status);
  expect((await listing()).routines.map((row: any) => row.id)).toEqual(before);
});
