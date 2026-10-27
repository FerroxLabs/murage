// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// RETAINED -> RELEASED_LATE through the real harness. An ACP turn ends, its
// engine child outlives the close deadline (termination held by a gate), and the
// run is retained with the unconfirmed line. When the child does close later,
// that close alone releases the run: the bot reads idle, one activity line
// says so, and the conversation takes the next message.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const LATE_NOTE = "Engine closed; you can continue this conversation.";
let fixture: VerificationServer, headers: Record<string, string>, model: string;
const file = (name: string) => join(fixture.info.dataDir, `late-close-${name}`);
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const task = async (botId: string, threadId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId)?.tasks?.find((entry: any) => entry.threadId === threadId);
const lines = async (threadId: string) =>
  ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[])
    .filter(message => message.kind === "activity").map(message => String(message.tool?.name ?? ""));

beforeAll(async () => {
  // The server reads the close deadline at call time; the launcher passes no MURAGE_* through, so set it in the server.
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      process.env.MURAGE_PROVIDER_CLOSE_MS='800';
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      const at=(name)=>path.join(process.env.MURAGE_DATA_DIR,'late-close-'+name);
      const {installCliStopGate}=await import(${JSON.stringify(new URL("./testing/cli-stop-gate.ts", import.meta.url).href)});
      installCliStopGate('late-close-fixture',at('gate'),at('host-engine-pid'));
      cfg.instances.lateClose={driver:'customAcp',displayName:'Late close ACP fixture',config:{cli:${JSON.stringify(FAKE_ACP)}},environment:{MURAGE_PROCESS_TAG:'late-close-fixture',FAKE_ACP_TERM:'gate',FAKE_ACP_PID_FILE:at('pid'),FAKE_ACP_TERM_MARK:at('term'),FAKE_ACP_EXIT_GATE:at('gate')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then(response => response.json() as Promise<any>);
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
}, 60_000);
afterAll(async () => { await fixture?.close(); });

it.skipIf(process.platform === "win32")("releases a retained direct run when its engine closes later, and only then", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Late close fixture", modelSelection: { instanceId: "verification", model } })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: { instanceId: "lateClose", model: "agent-default" } })).status).toBe(200);
  try {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "late close fixture" })).status).toBe(202);
    // The turn ended and its child was asked to stop, but holds on past the deadline: RETAINED.
    await expect.poll(() => existsSync(file("term")), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await lines(bot.threadId)).some(name => name.includes("provider stop is unconfirmed")), { timeout: 20_000 }).toBe(true)
      .catch(async (error) => { console.error("[late-close diag]", JSON.stringify((await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body).slice(0, 4000), JSON.stringify(await task(bot.id, bot.threadId))); throw error; });
    expect((await task(bot.id, bot.threadId))?.busy).toBe(true);
    expect(await lines(bot.threadId)).not.toContain(LATE_NOTE);
    // The engine has received TERM and is holding it. Linux records its host
    // PID separately: the engine's own pid file is in the cage's namespace.
    if (process.platform === "linux") await expect.poll(() => existsSync(file("host-engine-pid")), { timeout: 5_000 }).toBe(true);
    const pid = Number(readFileSync(file(process.platform === "linux" ? "host-engine-pid" : "pid"), "utf8"));
    expect(Number.isInteger(pid) && pid > 1 && pid <= 0x7fffffff).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
    // The child closes later: that confirmed close releases the run (RELEASED_LATE).
    writeFileSync(file("gate"), "");
    await expect.poll(async () => (await task(bot.id, bot.threadId))?.busy, { timeout: 20_000 }).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect((await lines(bot.threadId)).filter(name => name === LATE_NOTE)).toHaveLength(1);
    // The conversation continues.
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "after the late close" })).status).toBe(202);
  } finally {
    writeFileSync(file("gate"), "");
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }
}, 90_000);
