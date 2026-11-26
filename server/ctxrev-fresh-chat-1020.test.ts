// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: memory revoke fence (deny-read.ts pending windows). Consumer: direct turn dispatch (index.ts send fence).
// 1.0.20 ctxrev: an upgraded file carries a backlog of active revoke jobs whose runner is deferred (memory-worker "BG_DEFERRED"), so the
// jobs never drain. Every revoke leaves a `*` pending row, capped at its commit. A fresh chat with a new bot, begun long after every one of
// those commits, rests on none of them and must answer. The mounted Fuigo MCP slow start below reproduces the field refusal.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";
import type { Message } from "./store.ts";

const acpCli = new URL("./testing/fake-acp-cli.ts", import.meta.url).pathname;
const acpReply = "hello from fake acp";
const freshQuestion = "Fixture question";
const freshReply = "Fixture answer to the newcomer.";

function replyAfterQuestion(messages: Message[], question: string): Message | undefined {
  const index = messages.findIndex(m => m.role === "user" && m.kind === "text" && m.text === question);
  if (index < 0) return undefined;
  return messages.slice(index + 1).find(m => m.role === "bot" && m.kind === "text" && m.provenance === "provider" && !m.murageLine && m.text?.trim());
}

const parked = (textOnly: boolean) => `
 await import(${JSON.stringify(new URL("./testing/fake-engine-unwrapped-preload.mjs", import.meta.url).href)});
 const fs=await import('node:fs'),path=await import('node:path');
 const {registerHooks}=await import('node:module');
 registerHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/server/memory/memory-revocation.ts'))return result;
  const needle='export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions, resume = next !== undefined): void {';
  const source=String(result.source);if(source.split(needle).length!==2)throw new Error('missing revocation runner anchor');
  // the field's runner: every slice is deferred, so no job ever finishes
  return {...result,source:source.replace(needle,needle+'if(globalThis.__ctxrevParked)return;')};}});
 globalThis.__ctxrevParked=true;
 fs.chmodSync(${JSON.stringify(acpCli)},0o755);
 const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
 cfg.instances.acp={driver:'customAcp',config:{cli:${JSON.stringify(acpCli)}},environment:{FAKE_ACP_TEXT_ONLY:'${textOnly ? "1" : "0"}',
  FAKE_ACP_MENTION_MARKER:${JSON.stringify(freshQuestion)},FAKE_ACP_MENTION_REPLY:${JSON.stringify(freshReply)}}};
 fs.writeFileSync(file,JSON.stringify(cfg));
`;

/** The upgraded file's backlog, as revoke-commit.ts commitRevoke leaves each job: an active job capped at its commit plus its `*` windows. */
function seedBacklog(dataDir: string, jobs: number): void {
  const db = new DatabaseSync(join(dataDir, "messages.db"));
  try {
    db.exec("PRAGMA busy_timeout=10000; BEGIN IMMEDIATE");
    const cap = Number((db.prepare("SELECT next FROM memory_lsn WHERE id=1").get() as { next: number }).next);
    const job = db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'line','{}',1,?,'mark','','active')");
    const line = db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
    const scope = db.prepare("INSERT OR IGNORE INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('*',1,?)");
    for (let i = 0; i < jobs; i++) { job.run(900001 + i, cap); line.run(900001 + i); scope.run(900001 + i); }
    // the commits moved the file's clock past every cap: a turn begun now is a new turn for all of them
    db.prepare("UPDATE memory_lsn SET next=next+5 WHERE id=1").run();
    db.exec("COMMIT");
  } finally { db.close(); }
}

for (const [route, jobs] of [["acp", 400], ["acp-text", 400], ["acp", 0]] as const) it(`[${route}] a fresh chat with a new bot answers while ${jobs} older revoke jobs stay active (runner deferred)`, async () => {
  const fixture = await launchVerificationServer(process.env, undefined, { separateHome: true, turnLog: { replies: ["Fixture reply."] }, instrumentationSource: parked(route === "acp-text") });
  const run = (args: string[]) => runControlMurage([...args, "--url", fixture.info.url], { env: { MURAGE_DATA_DIR: fixture.info.dataDir } }) as Promise<any>;
  const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${fixture.info.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(r.ok, `${method} ${path}: ${r.status}`).toBe(true); return r.json() as Promise<any>;
  };
  const newBot = async (name: string) => (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "acp", model: "agent-default" } })).bot;
  try {
    // an earlier bot with a conversation, so the file is past first-run setup like the field's
    const first = await newBot("Fixture elder");
    await run(["send", "--bot", first.id, "--text", "Fixture warmup"]);
    await run(["wait", "--bot", first.id, "--timeout", "30"]);
    if (jobs) seedBacklog(fixture.info.dataDir, jobs);
    const bot = await newBot("Fixture newcomer");
    await run(["send", "--bot", bot.id, "--text", freshQuestion]);
    await run(["wait", "--bot", bot.id, "--timeout", "40"]);
    const transcript = await run(["messages", "--bot", bot.id, "--limit", "30"]);
    const rows = JSON.stringify(transcript);
    const log = readFileSync(fixture.info.logPath, "utf8");
    const refusals = log.split("\n").filter(l => /ledger refusal|native fence refusal|fence recovery|MEMORY_CONTEXT_REVOKED|consuming|refusing this turn/.test(l));
    console.log(`CTXREV route=${route} jobs=${jobs} rows=${rows.slice(0, 2500)}\nrefusals=${refusals.length}\n${refusals.slice(0, 20).join("\n")}`);
    expect(transcript.messages).toContainEqual(expect.objectContaining({ role: "bot", kind: "text", text: freshReply }));
    expect(rows).not.toContain("some of its context is no longer available");
    expect(rows).not.toContain("MEMORY_CONTEXT_REVOKED");
  } finally { await fixture.close(); }
}, 150_000);

// The field's shape: memory capture and recall on (the memory verification launcher), the fuigoAgent driver, an elder bot with captured
// memory and recent files from before the backlog, then the backlog of `*` windows with the runner parked.
const parkOnly = `
 const {registerHooks:parkHooks}=await import('node:module');
 parkHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/server/memory/memory-revocation.ts'))return result;
  const needle='export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions, resume = next !== undefined): void {';
  const source=String(result.source);if(source.split(needle).length!==2)throw new Error('missing revocation runner anchor');
  return {...result,source:source.replace(needle,needle+'if(globalThis.__ctxrevParked)return;')};}});
 globalThis.__ctxrevParked=true;
`;
const toolCalls = `
  process.env.FAKE_CUSTOM_TOOL_SERVER='agents';
  process.env.FAKE_CUSTOM_TOOL_LOG=(await import('node:path')).join(process.env.MURAGE_DATA_DIR,'native-tools.jsonl');
`;
for (const [engine, jobs, files, tools] of [["fuigo", 400, 17, true], ["fuigo", 0, 17, true], ["fuigo", 400, 17, false], ["fuigo", 400, 0, false], ["claude", 400, 17, true], ["fuigo", 0, 17, false]] as const) it(`[memory-on ${engine}${tools ? " tools" : ""}] owner turns answer while ${jobs} older revoke jobs stay active with ${files} recent files (runner deferred)`, async () => {
  const { proofWorld } = await import("./session-proof-world.ts");
  const world = await proofWorld(engine, "none", parkOnly + (tools ? toolCalls : ""));
  try {
    const elder = await world.bot();
    await world.turn(elder, "Fixture warmup: my favourite colour is teal.");
    if (files) world.write(db => {
      const addFile = db.prepare("INSERT INTO artifacts(id,name,kind,mime,bytes,sha256,extension,created_at,bot_id,thread_id,run_id,source_root,relative_path,source_fingerprint) VALUES(?,?,'document','text/markdown',1,?,'md',1,?,?,'fixture','fixture',?,'fixture')");
      for (let index = 0; index < files; index++) { const file = `fixture-file-${index}.md`; addFile.run(file, file, "0".repeat(64), elder.id, elder.threadId, file); }
    });
    if (jobs) seedBacklog(world.fixture.info.dataDir, jobs);
    const outcomes: string[] = [];
    const { task } = await world.api("POST", `/api/bots/${elder.id}/tasks`, { title: "Fixture new chat" });
    for (const [label, target] of [["elder", elder], ["elder-new-chat", { id: elder.id, threadId: task.threadId }], ["newcomer", await world.bot()]] as const) {
      const start = world.log().length;
      const question = `Fixture question for ${label}`;
      await world.api("POST", `/api/bots/${target.id}/messages`, { threadId: target.threadId, text: question });
      await expect.poll(async () => (await world.api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === target.id)?.busy, { timeout: 45_000 }).not.toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const { messages } = await world.api("GET", `/api/threads/${target.threadId}/messages?limit=100`);
      const rows = JSON.stringify(messages);
      const lines = world.log().slice(start).split("\n").filter(l => /ledger refusal|native fence refusal|fence recovery|MEMORY_CONTEXT_REVOKED|refus|recall skipped|turn dispatch|retained fence/.test(l));
      console.log(`CTXREV memory-on engine=${engine} tools=${tools} jobs=${jobs} files=${files} bot=${label} rows=${rows.slice(-2500)}\nlines=${lines.length}\n${lines.slice(0, 30).join("\n")}`);
      const refused = /some of its context is no longer available|MEMORY_CONTEXT_REVOKED|couldn't start this reply/.test(rows);
      outcomes.push(`${label}:${refused ? "refused" : replyAfterQuestion(messages, question) ? "answered" : "silent"}`);
    }
    expect(outcomes).toEqual(["elder:answered", "elder-new-chat:answered", "newcomer:answered"]);
  } finally { await world.fixture.close(); }
}, 240_000);

// The field's lease.ledger checking:not-built: the engine's MCP list reports Murage's servers still starting at its first read,
// with or without a parked backlog. v1.0.20 acp/core.ts refused at that first read (refuseDirect, driverRaised)
// and the owner was told the turn's context is no longer available. A server that becomes ready inside the turn's window answers; one that
// never does keeps the fail-closed refusal (the mounted gate's contract is unchanged).
for (const [shape, readyAfterMs, jobs, answers] of [
  ["slow start", 4_000, 0, true], ["slow start with backlog", 4_000, 400, true], ["never ready", 600_000, 0, false],
] as const)
it(`[mcp-initializing fuigo ${shape}] a fresh chat with a new bot and ${jobs} older revoke jobs ${answers ? "answers" : "stays refused"} while the engine lists its servers as starting`, async () => {
  const { proofWorld } = await import("./session-proof-world.ts");
  const world = await proofWorld("fuigo", "none", (jobs ? parkOnly : "") + `process.env.FAKE_ACP_MCP_LIST_READY_AFTER_MS='${readyAfterMs}';`);
  try {
    if (jobs) seedBacklog(world.fixture.info.dataDir, jobs);
    const bot = await world.bot();
    const start = world.log().length;
    const question = freshQuestion;
    await world.api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: question });
    await expect.poll(async () => (await world.api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 120_000, interval: 1000 }).not.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const { messages } = await world.api("GET", `/api/threads/${bot.threadId}/messages?limit=100`);
    const rows = JSON.stringify(messages);
    const log = world.log().slice(start);
    const lines = log.split("\n").filter(l => /ledger refusal|native fence refusal|MEMORY_CONTEXT_REVOKED|refus|mcp|submission/i.test(l));
    console.log(`CTXREV mcp-initializing shape=${shape} rows=${rows.slice(-1500)}\nlines=${lines.length}\n${lines.slice(0, 30).join("\n")}`);
    if (answers) {
      expect(replyAfterQuestion(messages, question)?.text, "engine reply after the question").toBe(acpReply);
      expect(rows).not.toContain("some of its context is no longer available");
      expect(rows).not.toContain("MEMORY_CONTEXT_REVOKED");
      expect(log).not.toContain("ledger refusal");
    } else {
      expect(log).toContain("ledger refusal cause=checking:not-built");
      expect(messages.some((m: Message) => m.role === "bot" && m.kind === "text" && !m.murageLine)).toBe(false);
    }
  } finally { await world.fixture.close(); }
}, 240_000);

// The field's other shape for the same gate (Astra H4, cause 3 only): not a new bot but an existing one with a conversation, the team
// changed (a bot added) between its turns, and every mounted turn's engine again listing Murage's servers as starting at its first read
// (each mounted turn gets a fresh engine process). v1.0.20 refused each of those turns at the first read; both must answer.
it("[mcp-initializing fuigo slow start, existing bot across a team change] the bot answers before and after the team changes", async () => {
  const { proofWorld } = await import("./session-proof-world.ts");
  const world = await proofWorld("fuigo", "none", "process.env.FAKE_ACP_MCP_LIST_READY_AFTER_MS='3000';");
  try {
    const elder = await world.bot();
    const outcomes: string[] = [];
    for (const step of ["before", "after"] as const) {
      if (step === "after") await world.bot(); // the team change: a new bot joins between the elder's turns
      const question = `Fixture question ${step} the team change`;
      await world.api("POST", `/api/bots/${elder.id}/messages`, { threadId: elder.threadId, text: question });
      await expect.poll(async () => (await world.api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === elder.id)?.busy, { timeout: 120_000, interval: 1000 }).not.toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const messages = (await world.api("GET", `/api/threads/${elder.threadId}/messages?limit=100`)).messages;
      const refused = /some of its context is no longer available|MEMORY_CONTEXT_REVOKED/.test(JSON.stringify(messages));
      outcomes.push(`${step}:${refused ? "refused" : replyAfterQuestion(messages, question)?.text === acpReply ? "answered" : "no-reply"}`);
    }
    console.log(`CTXREV mcp-initializing existing-bot outcomes=${outcomes.join(",")}`);
    expect(outcomes).toEqual(["before:answered", "after:answered"]);
  } finally { await world.fixture.close(); }
}, 300_000);
