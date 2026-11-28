// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F33 (owner q1024-autodefault; FABLE 881a97cd06 H1 class sweep): on a fresh install only a bot the owner creates takes the seeded
// Automatic level; a copy for a team starts at Ask, as on a 1.0.23 fresh install. Booted server over HTTP; the owner's bot and the first
// Chief are control rows. The create_bot row is a guard: this harness reaches only the staged create, which applies the creator's level.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FAKE_ENGINE_NAME, launchVerificationServer, verificationInstances } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const level = (bot: { autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean } | undefined) =>
  !bot ? "missing" : !bot.autoApprove ? "ask" : !bot.fullAccess ? "auto" : bot.noLimits ? "no-limits" : "full";

it("W-F33-ROUTES: on a fresh install a bot-made bot and a team copy start at Ask; the owner's own bot starts in Automatic", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, { freshInstall: true });
  try {
    const config = join(fixture.info.dataDir, "config.json");
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), instances: verificationInstances(join(fixture.info.dataDir, FAKE_ENGINE_NAME)) }, null, 2));
    await fixture.restart();
    const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret }) => {
      const res = await fetch(fixture.info.url + path, { signal: AbortSignal.timeout(30_000), method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, body: (() => { try { return JSON.parse(text); } catch { return text; } })() as any };
    };
    const ok = async (method: string, path: string, body?: unknown) => {
      const answer = await call(method, path, body);
      if (answer.status < 200 || answer.status > 299) throw new Error(`setup: ${method} ${path} answered ${answer.status} ${JSON.stringify(answer.body)}`);
      return answer.body;
    };
    const bots = async () => (await ok("GET", "/api/bots")).bots as Array<{ id: string; name: string; autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean }>;
    await ok("POST", "/api/memory/action", { action: "configure", mode: "off" });
    // control rows: the first Chief Murage seeds for the owner at boot, and the owner's own bot, take the seeded Automatic level
    const seeded = await bots();
    expect(seeded.length, "the first Chief is seeded at boot").toBeGreaterThan(0);
    expect.soft(seeded.map(level), "the seeded first Chief").toEqual(seeded.map(() => "full"));
    const director = (await ok("POST", "/api/bots", { name: "Route Director" })).bot;
    expect(level(director), "the owner's own bot").toBe("full");
    await ok("PATCH", `/api/bots/${director.id}`, { section: "Demo Machine", chiefOfStaff: true });
    const sales = (await ok("POST", "/api/bots", { name: "Route Sales" })).bot;
    await ok("PATCH", `/api/bots/${sales.id}`, { section: "Sales", chiefOfStaff: true });

    // row 1: a copy for a team (server/sharing-routes.ts copyForTeam)
    await ok("PATCH", `/api/bots/${director.id}/sharing`, { mode: "all" });
    const team = ((await ok("GET", `/api/bots/${director.id}/sharing`)).teams as Array<{ id: string; name: string }>).find(item => item.name === "Sales");
    const copy = await call("POST", `/api/bots/${director.id}/sharing/copy`, { teamId: team?.id });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect.soft(level((await bots()).find(bot => bot.id === copy.body?.bot?.id)), "a copy for a team starts at Ask").toBe("ask");

    // row 2: a bot made by a bot (POST /api/internal/create-bot from a live turn's own credential)
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${director.id}/messages`, { text: "__fixture_hold_authority__", threadId: director.threadId })).status).toBe(202);
    let token = "", turnPid = 0;
    for (const deadline = Date.now() + 45_000; !token && Date.now() < deadline; await new Promise((r) => setTimeout(r, 250))) {
      try { const dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); token = dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN ?? ""; turnPid = dump.pid; } catch { /* not written yet */ }
    }
    if (!token) throw new Error("setup: the held turn never started");
    const made = await call("POST", "/api/internal/create-bot", { fromBotId: director.id, fromThreadId: director.threadId, role: "Route specialist", instructions: "Serve the client.", name: "Route Made" }, { authorization: `Bearer ${token}` });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    writeFileSync(join(fixture.fixtureFinishGateDir, String(turnPid)), "finish");
    let madeBot: any;
    await expect.poll(async () => (madeBot = (await bots()).find(bot => bot.name === "Route Made")) !== undefined, { timeout: 30_000, interval: 300 }).toBe(true);
    expect.soft(level(madeBot), "a bot made by a bot starts at Ask").toBe("ask");
  } finally { await fixture.close(); }
}, 240_000);
