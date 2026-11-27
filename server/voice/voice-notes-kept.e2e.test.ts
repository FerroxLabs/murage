// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The documented isolated fixture, real dispatch and voice endpoint, loopback Flux speech.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { withTurnSecrets } from "../testing/fixture-dump.ts";

const MP3 = Buffer.from([0xff, 0xf3, 0x44, 0xc4]);
let fixture: VerificationServer;
let speech: Server;
let headers: Record<string, string>;
let rejectSpeech = false;
const api = async (method: string, path: string, body?: unknown, proof = headers) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...proof, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = { status: response.status, body: await response.json() as any };
  return result;
};
const rows = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages;
const busy = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId)?.busy;
const dispatches = () => existsSync(fixture.fixtureDumpLogPath) ? readFileSync(fixture.fixtureDumpLogPath, "utf8").trim().split("\n").filter(Boolean).length : 0;

beforeAll(async () => {
  speech = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the request */ }
    if (req.url?.endsWith("/audio/voices")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "marin", model: "flux-voice-speak", entitlement: "open" }] })); return; }
    res.writeHead(rejectSpeech ? 503 : 200, { "content-type": rejectSpeech ? "application/json" : "audio/mpeg" });
    res.end(rejectSpeech ? JSON.stringify({ error: "fixture speech unavailable" }) : MP3);
  });
  await new Promise<void>(resolve => speech.listen(0, "127.0.0.1", resolve));
  const port = (speech.address() as { port: number }).port;
  // Extend only the isolated fake CLI's finish gate: "fail" ends with an engine
  // error after the real endpoint has saved the note. Production code is untouched.
  const original = new URL("../testing/fake-claude-cli.ts", import.meta.url);
  const anchor = 'out({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });';
  let cli = readFileSync(original, "utf8").replace(/from "(\.[^"]+)"/g, (_match, path: string) => `from ${JSON.stringify(new URL(path, original).href)}`);
  expect(cli).toContain(anchor);
  cli = cli.replace('unlinkSync(gate);\n      clearInterval(timer);', 'const ending = readFileSync(gate, "utf8");\n      unlinkSync(gate);\n      clearInterval(timer);');
  cli = cli.replace(anchor, 'out(ending === "fail" ? { type: "result", subtype: "error_during_execution", is_error: true, errors: ["fixture export failed"], stop_reason: "error", total_cost_usd: 0 } : { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", total_cost_usd: 0 });');
  fixture = await launchVerificationServer(process.env, undefined, { dumpLog: true, instrumentationSource: `
    process.env.MURAGE_FLUX_AUDIO_API=${JSON.stringify(`http://127.0.0.1:${port}/v1`)};
    process.env.FLUX_API_KEY=["sk","flux","fixture","voice"].join("-");
    const {readFileSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const root=process.env.MURAGE_DATA_DIR;const cli=join(root,'voice-fixture-cli.ts');
    writeFileSync(cli,${JSON.stringify(cli)},{mode:0o755});
    const configFile=join(root,'config.json');const config=JSON.parse(readFileSync(configFile,'utf8'));
    config.instances.verification.config.cli=cli;writeFileSync(configFile,JSON.stringify(config));
  ` });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 150_000);
afterAll(async () => {
  if (fixture) {
    await fixture.close();
  }
  speech?.closeAllConnections();
  if (speech) await new Promise<void>(resolve => speech.close(() => resolve()));
}, 30_000);

async function start(name: string) {
  const instance = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "verification");
  const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: instance.models.options[0]?.id || instance.models.default || "fixture-model" } });
  expect(made.status).toBe(201);
  const bot = made.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { browser: false, computer: "off", composio: false, voiceProvider: "flux", voice: "marin" })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${name}` })).status).toBe(202);
  let dump: any;
  await expect.poll(() => {
    try { dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); return dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_BOT_ID === bot.id; } catch { return false; }
  }, { timeout: 30_000 }).toBe(true);
  return { bot, dump, proof: { authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}` } };
}

it.each(["failure", "stop"])("keeps a recorded voice note above its %s ending and never starts another turn", async ending => {
  const { bot, dump, proof } = await start(`Voice ${ending} fixture`);
  try {
    const note = await api("POST", "/api/internal/voice-note", { text: "The first step is complete." }, proof);
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    const before = await rows(bot.threadId);
    const attached = before.find(row => row.artifactIds?.includes(note.body.artifact.id));
    expect(attached).toBeTruthy();
    const audioDir = join(fixture.info.dataDir, "artifact-files");
    expect(readdirSync(audioDir).some(file => file.endsWith(".mp3"))).toBe(true);
    if (ending === "failure") {
      // The voice-tool loop guard is per capability generation. Its rejection
      // must leave earlier notes intact and must never dispatch a new turn.
      for (const text of ["Second saved note.", "Third saved note."]) expect((await api("POST", "/api/internal/voice-note", { text }, proof)).status).toBe(201);
      const guarded = await api("POST", "/api/internal/voice-note", { text: "Fourth note." }, proof);
      expect(guarded.status).toBe(429);
      expect(guarded.body.sent).not.toBe(true);
    }
    const turns = dispatches();
    if (ending === "failure") writeFileSync(join(fixture.fixtureFinishGateDir, String(dump.pid)), "fail");
    else expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    await expect.poll(() => busy(bot.id), { timeout: 30_000 }).toBe(false);
    let after: any[] = [];
    let terminal: any;
    await expect.poll(async () => {
      after = await rows(bot.threadId);
      terminal = after.findLast(row => row.kind === "activity" && (row.tool?.ok === false || /Stopped/.test(row.tool?.name ?? "")));
      return Boolean(terminal);
    }, { timeout: 15_000 }).toBe(true);
    expect(after.find(row => row.id === attached.id)?.artifactIds).toContain(note.body.artifact.id);
    expect(terminal, JSON.stringify(after)).toBeTruthy();
    expect(after.findIndex(row => row.id === attached.id)).toBeLessThan(after.indexOf(terminal));
    const audio = await fetch(`${fixture.info.url}/api/threads/${bot.threadId}/messages/${attached.id}/voice-note`, { headers });
    expect(audio.status).toBe(200);
    expect(Buffer.from(await audio.arrayBuffer())).toEqual(MP3);
    // The settled capability cannot record again. A note and a failed note request
    // are output, never owner input: neither may restart the failed turn.
    expect((await api("POST", "/api/internal/voice-note", { text: "Do not restart." }, proof)).status).not.toBe(201);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(dispatches()).toBe(turns);
    expect(await busy(bot.id)).toBe(false);
    // The receipt must identify the saved audio, after both copies and the row exist.
    expect(note.body.file).toEqual(expect.stringMatching(/\.mp3$/));
  } finally { if (await busy(bot.id)) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
}, 90_000);

it("returns no save acknowledgement or attachment when speech fails", async () => {
  const { bot, proof } = await start("Voice unavailable fixture");
  rejectSpeech = true;
  try {
    const note = await api("POST", "/api/internal/voice-note", { text: "This must not be called sent." }, proof);
    expect(note.status).toBe(502);
    expect(note.body.sent).not.toBe(true);
    expect((await rows(bot.threadId)).some(row => row.artifactIds?.length)).toBe(false);
  } finally { rejectSpeech = false; await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
}, 90_000);
