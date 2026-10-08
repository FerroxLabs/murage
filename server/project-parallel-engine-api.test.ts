// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
let fixture: VerificationServer;
let proof: string;
let fixtureRoot: string;
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  fixtureRoot = mkdtempSync(join(here, ".e2b-fixtures-"));
  vi.stubEnv("TMPDIR", fixtureRoot);
  for (const name of ["accepted", "stop-accepted", "retry-accepted", "mixed-accepted"]) mkdirSync(join(fixtureRoot, name));
  const fake = join(here, "testing", "fake-acp-cli.ts");
  chmodSync(fake, 0o755);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.cardlead={driver:'grokAgent',displayName:'Card lead fixture',environment:{FAKE_ACP_MODE:'project-card-lead'},config:{cli:${JSON.stringify(fake)},fullAuto:true}};
    cfg.instances.parallel={driver:'grokAgent',displayName:'Parallel fixture',environment:{FAKE_ACP_MODE:'parallel-card',FAKE_ACP_ACCEPT_DIR:${JSON.stringify(join(fixtureRoot, 'accepted'))},FAKE_ACP_GATE_FILE:${JSON.stringify(join(fixtureRoot, 'finish'))}},config:{cli:${JSON.stringify(fake)},fullAuto:true}};
    cfg.instances.parallelstop={driver:'grokAgent',displayName:'Parallel Stop fixture',environment:{FAKE_ACP_MODE:'cancel-ack',FAKE_ACP_ACCEPT_DIR:${JSON.stringify(join(fixtureRoot, 'stop-accepted'))}},config:{cli:${JSON.stringify(fake)},fullAuto:true}};
    cfg.instances.parallelretry={driver:'grokAgent',displayName:'Retry fixture',environment:{FAKE_ACP_MODE:'parallel-card-retry',FAKE_ACP_ACCEPT_DIR:${JSON.stringify(join(fixtureRoot, 'retry-accepted'))},FAKE_ACP_FAIL_ONCE_FILE:${JSON.stringify(join(fixtureRoot, 'retry-failed'))},FAKE_ACP_GATE_FILE:${JSON.stringify(join(fixtureRoot, 'retry-finish'))}},config:{cli:${JSON.stringify(fake)},fullAuto:true}};
    cfg.instances.mixedretry={driver:'grokAgent',displayName:'Mixed retry fixture',environment:{FAKE_ACP_MODE:'parallel-card-retry',FAKE_ACP_ACCEPT_DIR:${JSON.stringify(join(fixtureRoot, 'mixed-accepted'))},FAKE_ACP_FAIL_ONCE_FILE:${JSON.stringify(join(fixtureRoot, 'mixed-failed'))},FAKE_ACP_GATE_FILE:${JSON.stringify(join(fixtureRoot, 'mixed-finish'))}},config:{cli:${JSON.stringify(fake)},fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  proof = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
}, 30000);
afterAll(async () => { await fixture?.close(); if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it("three card desks overlap, then each delivers once and wakes the lead", async () => {
  const instances = (await api("GET", "/api/instances")).body.instances;
  const makeBot = async (name: string, instanceId: string) => {
    const instance = instances.find((entry: any) => entry.instanceId === instanceId);
    const result = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: instance.models.options[0].id } });
    expect(result.status).toBe(201);
    await api("PATCH", `/api/bots/${result.body.bot.id}`, { computer: "off", browser: false, composio: false });
    return result.body.bot;
  };
  const lead = await makeBot("Finch", "cardlead");
  const workers = [];
  for (const name of ["Jax", "Ivy", "Dax"]) workers.push(await makeBot(name, "parallel"));
  const group = (await api("POST", "/api/groups", { name: "Parallel cards", memberIds: [lead.id, ...workers.map(bot => bot.id)], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } })).body.group;
  expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Finish three independent cards" } })).status).toBe(200);
  try {
  const ids: string[] = [];
  for (const [i, bot] of workers.entries()) {
    const card = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: `parallel-${i}`, title: `Independent card ${i}`, assigneeBotId: bot.id, writes: false })).body.card;
    ids.push(card.id);
    expect((await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: card.revision, action: "start" })).status).toBe(200);
  }
  const board = async () => (await api("GET", `/api/groups/${group.id}/board`)).body.cards;
  await expect.poll(async () => (await board()).filter((card: any) => card.state === "doing").length, { timeout: 45000 }).toBe(3);
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    const live = db.prepare("SELECT dispatched_at FROM room_requests WHERE group_id=? AND verb='assign' AND state='running' ORDER BY dispatched_at").all(group.id) as Array<{ dispatched_at: number }>;
    expect(live).toHaveLength(3);
    // Admission spaces card starts 2000 ms apart on its own clock reading (work-admission.ts);
    // dispatched_at is a later reading per card, so each gap may come out a few ms short of it.
    expect(live[1].dispatched_at - live[0].dispatched_at).toBeGreaterThanOrEqual(2000 - 50);
    expect(live[2].dispatched_at - live[1].dispatched_at).toBeGreaterThanOrEqual(2000 - 50);
  } finally { db.close(); }
  expect(new Set((await board()).map((card: any) => card.deskThreadId)).size).toBe(3);
  await expect.poll(() => readdirSync(join(fixtureRoot, "accepted")).filter(name => name.endsWith(".accepted")).length, { timeout: 45000 }).toBe(3);
  // All three fake processes accepted their prompts and remain behind the gate.
  writeFileSync(join(fixtureRoot, "finish"), "finish");
  await expect.poll(async () => (await board()).filter((card: any) => card.state === "done").length, { timeout: 45000 }).toBe(3);
  await expect.poll(async () => (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages.some((message: any) => message.text?.includes("CARD_RESULT_RECEIVED")), { timeout: 45000 }).toBe(true);
  const room = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages;
  expect(room.filter((message: any) => message.murage?.kind === "result")).toHaveLength(3);
  for (const id of ids) expect((await board()).find((card: any) => card.id === id)).toMatchObject({ generation: 1, attempt: 1 });
  } finally {
    writeFileSync(join(fixtureRoot, "finish"), "finish");
    // Even an assertion before gate release cannot strand the install's slots.
    expect((await api("POST", `/api/groups/${group.id}/project/control/stop`, {})).status).toBe(200);
    await expect.poll(async () => (await api("GET", `/api/groups/${group.id}/board`)).body.cards.filter((card: any) => card.state === "doing").length, { timeout: 45000 }).toBe(0);
  }
}, 120000);

it("Stop all parks every live card, keeps generations fenced and does not restart them", async () => {
  const instance = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "parallelstop");
  const workers = [];
  for (const name of ["Stop A", "Stop B", "Stop C"]) {
    const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "parallelstop", model: instance.models.options[0].id } });
    expect(made.status).toBe(201); workers.push(made.body.bot);
    await api("PATCH", `/api/bots/${made.body.bot.id}`, { computer: "off", browser: false, composio: false });
  }
  const group = (await api("POST", "/api/groups", { name: "Stop parallel cards", memberIds: workers.map(bot => bot.id), setup: { bulletin: "", defaultResponder: { kind: "member", botId: workers[0].id } } })).body.group;
  expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Stop every card" } })).status).toBe(200);
  try {
  for (const [i, bot] of workers.entries()) {
    const card = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: `stop-${i}`, title: `Stop card ${i}`, assigneeBotId: bot.id, writes: false })).body.card;
    expect((await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: card.revision, action: "start" })).status).toBe(200);
  }
  const board = async () => (await api("GET", `/api/groups/${group.id}/board`)).body.cards;
  await expect.poll(async () => (await board()).filter((card: any) => card.state === "doing").length, { timeout: 45000 }).toBe(3);
  // Prove all engines accepted their prompts before Stop, not just admission.
  await expect.poll(() => readdirSync(join(fixtureRoot, "stop-accepted")).filter(name => name.endsWith(".accepted")).length, { timeout: 45000 }).toBe(3);
  expect((await api("POST", `/api/groups/${group.id}/project/control/stop`, {})).status).toBe(200);
  await expect.poll(async () => (await board()).filter((card: any) => card.state === "waiting" && card.waitingOn?.kind === "stopped").length, { timeout: 45000 }).toBe(3);
  for (const card of await board()) expect(card).toMatchObject({ failures: 0, generation: 1, attempt: 1 });
  expect((await api("GET", `/api/groups/${group.id}/project`)).body.settings.runState).toBe("paused");
  } finally {
    await api("POST", `/api/groups/${group.id}/project/control/stop`, {});
  }
}, 120000);

it("a 429 at start retries once with one desk prompt and unchanged card identity", async () => {
  const instances = (await api("GET", "/api/instances")).body.instances;
  const bots = [];
  for (const [name, instanceId] of [["Retry lead", "cardlead"], ["Retry worker", "parallelretry"]]) {
    const instance = instances.find((entry: any) => entry.instanceId === instanceId);
    const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: instance.models.options[0].id } });
    expect(made.status).toBe(201); bots.push(made.body.bot);
    await api("PATCH", `/api/bots/${made.body.bot.id}`, { computer: "off", browser: false, composio: false });
  }
  const group = (await api("POST", "/api/groups", { name: "Retry start", memberIds: bots.map(bot => bot.id), setup: { bulletin: "", defaultResponder: { kind: "member", botId: bots[0].id } } })).body.group;
  expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Retry an empty start" } })).status).toBe(200);
  try {
    const card = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: "retry-one", title: "Retry card", assigneeBotId: bots[1].id, writes: false })).body.card;
    expect((await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: card.revision, action: "start" })).status).toBe(200);
    await expect.poll(() => readdirSync(join(fixtureRoot, "retry-accepted")).filter(name => name.endsWith(".accepted")).length, { timeout: 60000 }).toBe(1);
    const board = async () => (await api("GET", `/api/groups/${group.id}/board`)).body.cards;
    const running = (await board()).find((entry: any) => entry.id === card.id);
    expect(running).toMatchObject({ state: "doing", generation: 1, attempt: 1 });
    const messages = (await api("GET", `/api/threads/${running.deskThreadId}/messages`)).body.messages;
    expect(messages.filter((message: any) => message.role === "user" && message.requestId === running.requestId)).toHaveLength(1);
    const room = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages;
    expect(room.filter((message: any) => message.murage?.kind === "status" && message.tool?.name?.includes("started 'Retry card'"))).toHaveLength(1);
    writeFileSync(join(fixtureRoot, "retry-finish"), "finish");
    await expect.poll(async () => (await board()).find((entry: any) => entry.id === card.id)?.state, { timeout: 45000 }).toBe("done");
    expect((await board()).find((entry: any) => entry.id === card.id)).toMatchObject({ generation: 1, attempt: 1 });
  } finally {
    writeFileSync(join(fixtureRoot, "retry-finish"), "finish");
    await api("POST", `/api/groups/${group.id}/project/control/stop`, {});
  }
}, 120000);


it.each(["Stop all", "bot Stop", "restart"])("%s handles a live card beside a backoff without replay", async action => {
  const instance = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "mixedretry");
  const makeBot = async (name: string) => {
    const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "mixedretry", model: instance.models.options[0].id } });
    expect(made.status).toBe(201);
    await api("PATCH", `/api/bots/${made.body.bot.id}`, { computer: "off", browser: false, composio: false });
    return made.body.bot;
  };
  const liveBot = await makeBot(`Live ${action}`), retryBot = action === "bot Stop" ? liveBot : await makeBot(`Backoff ${action}`);
  const makeGroup = async (name: string) => {
    const made = await api("POST", "/api/groups", { name, memberIds: [...new Set([liveBot.id, retryBot.id])], setup: { bulletin: "", defaultResponder: { kind: "member", botId: liveBot.id } } });
    expect(made.status).toBe(201);
    expect((await api("PATCH", `/api/groups/${made.body.group.id}`, { channelProject: { goal: "Handle interrupted cards" } })).status).toBe(200);
    return made.body.group;
  };
  const group = await makeGroup(`Mixed ${action}`), retryGroup = action === "bot Stop" ? await makeGroup("Other bot desk") : group;
  const groups = [...new Map([group, retryGroup].map(g => [g.id, g])).values()];
  const makeCard = async (g: any, bot: any, title: string) => {
    const made = await api("POST", `/api/groups/${g.id}/board/cards`, { clientId: `${g.id}-${bot.id}-${title.replaceAll(" ", "-")}`, title, description: "__fixture_cancel_ack__", assigneeBotId: bot.id, writes: false });
    expect(made.status).toBe(200);
    expect((await api("PATCH", `/api/groups/${g.id}/board/cards/${made.body.card.id}`, { expectedRevision: made.body.card.revision, action: "start" })).status).toBe(200);
    return made.body.card;
  };
  const accepted = () => readdirSync(join(fixtureRoot, "mixed-accepted")).filter(name => name.endsWith(".accepted")).length;
  const countBefore = accepted();
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  const requestFor = (id: string) => db.prepare("SELECT id,state,dispatched_at FROM room_requests WHERE work_item_id=? AND verb='assign'").get(id);
  try {
    // First launch waits for cancellation; the second fails before any output.
    writeFileSync(join(fixtureRoot, "mixed-failed"), "first launch already allowed");
    const live = await makeCard(group, liveBot, "Live card");
    await expect.poll(accepted, { timeout: 45000 }).toBe(countBefore + 1);
    rmSync(join(fixtureRoot, "mixed-failed"));
    const backoff = await makeCard(retryGroup, retryBot, "Backoff card");
    await expect.poll(() => {
      const row = requestFor(backoff.id);
      return row?.state === "queued" && row.dispatched_at !== null;
    }, { timeout: 45000, interval: 20 }).toBe(true);
    expect(requestFor(live.id)?.state).toBe("running");
    if (action === "Stop all") expect((await api("POST", `/api/groups/${group.id}/project/control/stop`, {})).status).toBe(200);
    else if (action === "bot Stop") expect((await api("POST", `/api/bots/${liveBot.id}/interrupt`, { all: true })).status).toBe(200);
    else {
      await fixture.restart();
      proof = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    }
    const board = async (g: any) => (await api("GET", `/api/groups/${g.id}/board`)).body.cards;
    for (const [g, card] of [[group, live], [retryGroup, backoff]]) {
      await expect.poll(async () => (await board(g)).find((c: any) => c.id === card.id)?.waitingOn?.kind, { timeout: 45000 }).toBe(action === "restart" ? "restart" : "stopped");
      expect((await board(g)).find((c: any) => c.id === card.id)).toMatchObject({ state: "waiting", generation: 1, attempt: 1, failures: 0 });
      if (action === "restart") expect(requestFor(card.id)?.state).toBe("unknown");
    }
    // Cross the abandoned retry deadline; no second provider prompt is accepted.
    await new Promise(resolve => setTimeout(resolve, 6500));
    expect(accepted()).toBe(countBefore + 1);
    for (const card of [live, backoff]) expect(requestFor(card.id)?.state).not.toBe("running");
  } finally {
    db.close();
    for (const g of groups) await api("POST", `/api/groups/${g.id}/project/control/stop`, {});
  }
}, 120000);
