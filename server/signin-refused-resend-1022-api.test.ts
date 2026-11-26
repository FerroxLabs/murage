// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 (field gate). Owners: lane fix1022-withheld-fable owns this witness, server/engine-signin-owed.ts and the sign-in line of a
// refused send (memory/dispatch.ts turnRefusedSignInLine, index.ts signInRefusedLine); the submission boundary and its refusal rows
// belong to their owners (turn-dispatch-guard.ts, D7 resend rows).
//
// Field shape, 1.0.21, Claude: the login expired, the message was sent again, Murage refused to repeat the send and the row read
// only that "the checks before sending did not pass". The person could not tell that signing in was the way out.
// Real server, real dispatch (POST /api/bots/:id/messages), the in-process fixture driver (testing/fake-late-terminal-driver.ts)
// playing the engine's side: its prompt is written, it says it needs signing in (the frame claude.ts sends for an expired login),
// then the turn is sent again through the fence and refused. Both refusal rows of a direct chat are driven: the card of a later
// write refused after a released one (index.ts acceptedBy, priorSubmissionReleased) and the note of a refused terminal event
// (index.ts turnRefusalNotes.note).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { RESEND_OFFER_LINE } from "../shared/resend-offer.ts";
import { turnRefusedLine } from "./memory/dispatch.ts";

const ENGINE = "Fixture engine";
const SIGN_IN_LINE = `${ENGINE} needs you to sign in again, so Murage did not send your message again. Sign in to ${ENGINE} in Settings, Models & engines, then send it again.`;
const VAGUE = /could not send it again because the submission checks failed/;
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${method} ${path} ${response.status}`).toBe(true);
  return await response.json() as any;
};
const gate = (name: string) => join(fixture.info.dataDir, `${name}-resend-gate`);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
const toolName = (message: any) => String(message.tool?.name ?? "");
const refusalRows = (all: any[]) => all.filter(message => message.role === "bot" && message.kind === "activity" && message.tool?.errorDetails === "submission_refused");
async function newBot(instanceId: string) {
  const bot = (await api("POST", "/api/bots", { name: `Bot ${instanceId}`, modelSelection: { instanceId, model: "late-1" } })).bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
}
/** One owner line on an engine that is sent again after its prompt was written: the second send is refused (memory was switched
 * off meanwhile, so the checks before sending no longer pass). Returns the thread's rows once the refusal row is stored. */
async function refusedResend(instanceId: string) {
  const bot = await newBot(instanceId);
  await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "say hello once" });
  await expect.poll(() => existsSync(`${gate(instanceId)}.waiting`), { timeout: 20000 }).toBe(true);
  await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
  writeFileSync(gate(instanceId), "");
  await expect.poll(async () => refusalRows(await messages(bot.threadId)).length + (await messages(bot.threadId)).filter(m => m.memoryNote === "resend").length, { timeout: 20000 }).toBeGreaterThan(0);
  // give a stray second row the time it would take
  await new Promise(resolve => setTimeout(resolve, 1500));
  return messages(bot.threadId);
}

describe.skipIf(process.platform === "win32")("1.0.22: a send refused again on an engine that needs signing in says so", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      const dir=process.env.MURAGE_DATA_DIR; const file=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      const engine=(name,environment)=>({driver:'fakeLateTerminal',displayName:${JSON.stringify(ENGINE)},environment:{FAKE_LATE_HANDBACK:'1',...environment}});
      cfg.instances.signedout=engine('signedout',{FAKE_LATE_AUTH_REQUIRED:'1',FAKE_LATE_RESEND_GATE:path.join(dir,'signedout-resend-gate')});
      cfg.instances.signedin=engine('signedin',{FAKE_LATE_RESEND_GATE:path.join(dir,'signedin-resend-gate')});
      cfg.instances.notesignedout=engine('notesignedout',{FAKE_LATE_AUTH_REQUIRED:'1',FAKE_LATE_REFUSE_AFTER_FENCE:'1'});
      cfg.instances.notesignedin=engine('notesignedin',{FAKE_LATE_REFUSE_AFTER_FENCE:'1'});
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("S1 card site: the engine said it needs signing in, the turn is sent again and refused: ONE row names the sign-in, never the bare check failure", async () => {
    const all = await refusedResend("signedout");
    const refused = refusalRows(all);
    expect(refused.map(toolName), JSON.stringify(all.map(m => [m.kind, toolName(m), m.memoryNote ?? ""]))).toEqual([`error: ${SIGN_IN_LINE}`]);
    expect(refused[0].tool.ok).toBe(false);
    expect(all.filter(m => m.memoryNote === "resend")).toEqual([]);
    expect(JSON.stringify(all)).not.toMatch(VAGUE);
  }, 90000);

  it("S2 card site control: the same refused resend on an engine that never said it needs signing in keeps its own row", async () => {
    const all = await refusedResend("signedin");
    const rows = [...refusalRows(all), ...all.filter(m => m.memoryNote === "resend")];
    expect(rows.map(toolName)).toEqual([`error: ${turnRefusedLine(ENGINE, "after-submission")}`]);
    expect(JSON.stringify(all)).not.toContain("needs you to sign in again");
  }, 90000);

  it("S3 note site: the engine said it needs signing in and then refused the released write: the ONE resend row names the sign-in", async () => {
    const bot = await newBot("notesignedout");
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "say hello once" });
    await expect.poll(async () => (await messages(bot.threadId)).filter(m => m.memoryNote === "resend").length, { timeout: 20000 }).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all = await messages(bot.threadId);
    // D7's ONE resend row stays (its Send again and the message it is for); only its line names the sign-in
    const resend = all.filter(m => m.memoryNote === "resend");
    expect(resend.map(toolName), JSON.stringify(all.map(m => [m.kind, toolName(m), m.memoryNote ?? ""]))).toEqual([SIGN_IN_LINE]);
    expect(resend[0].tool.ok).toBe(true);
    expect(resend[0].resendOf).toEqual({ messageId: all.find(m => m.role === "user")!.id, threadId: bot.threadId, botId: bot.id });
    expect(refusalRows(all)).toEqual([]);
    expect(JSON.stringify(all)).not.toContain(RESEND_OFFER_LINE);
    expect(JSON.stringify(all)).not.toMatch(VAGUE);
  }, 90000);

  it("S4 note site control: with no sign-in fact the D7 resend row is unchanged", async () => {
    const bot = await newBot("notesignedin");
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "say hello once" });
    await expect.poll(async () => (await messages(bot.threadId)).filter(m => m.memoryNote === "resend").length, { timeout: 20000 }).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all = await messages(bot.threadId);
    expect(all.filter(m => m.memoryNote === "resend").map(toolName)).toEqual([RESEND_OFFER_LINE]);
    expect(refusalRows(all)).toEqual([]);
    expect(JSON.stringify(all)).not.toContain("needs you to sign in again");
  }, 90000);
});
