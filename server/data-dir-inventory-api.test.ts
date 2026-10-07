// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The runtime half of data-dir-inventory.test.ts: a real server on a
// throwaway data folder (launchVerificationServer, its own port, HOME outside
// the folder, the fake Claude CLI), driven through the owner's features. A
// preload records every file or folder the server process creates at the
// folder's root as it happens, so a temp file renamed away a moment later
// still counts. Every recorded and remaining name must be classified, and a
// real backup inventory of the folder must then succeed.
//
// This is the path that broke on the 0.1.60 final draft: Settings > About me
// wrote about-me.md, and every backup after it stopped with
// BACKUP_UNCLASSIFIED_COMPONENT (Mac customer re-test 2, 2026-09-26).
// Synthetic fixture text only; loopback server, no network or credentials.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { dataDirWriteRecorder, unclassifiedDataDirNames } from "./testing/data-dir-guard.ts";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { inventoryFidelity } from "./installation-fidelity-snapshot.ts";
import { stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
/** What launchVerificationServer itself puts in the folder, not Murage. */
const HARNESS = new Set(["fake-claude-dump.json", "finish-fake", ".verification-instrumentation.mjs"]);


let fixture: VerificationServer, headers: Record<string, string>, logDir: string, log: string;
let sequence = 0;
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: response.status, body: parsed };
};
const api = async (method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
};
const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return null; } };
const idle = async () => { const state = await api("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working); };
async function turnFinished(tag: string) {
  await expect.poll(() => JSON.stringify(dump()?.prompt ?? null).includes(tag), { timeout: 20000 }).toBe(true);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);
}
async function skillZip(): Promise<string> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from("---\nname: invoice-chaser\ndescription: Chase invoices politely.\n---\nDraft polite reminders.\n"), "invoice-chaser/SKILL.md");
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("base64");
}

posixOnly("a real server's data folder stays backup-classified", () => {
  beforeAll(async () => {
    logDir = mkdtempSync(join(tmpdir(), "murage-data-dir-writes-"));
    log = join(logDir, "created.txt");
    fixture = await launchVerificationServer(process.env, undefined, { whatsNew: "pending", separateHome: true, instrumentationSource: `process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";\n${dataDirWriteRecorder(log)}` });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret };
  }, 60000);
  afterAll(async () => {
    await fixture?.close();
    if (logDir) rmSync(logDir, { recursive: true, force: true });
  });

  it("classifies every name the owner's features create, and a backup of the folder succeeds", async () => {
    const model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    const moss = (await api("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).bot;
    await api("PATCH", `/api/bots/${moss.id}`, { computer: "off", browser: false, composio: false });
    // The 0.1.60 owner settings, each saved the way the Settings page saves it.
    await api("PUT", "/api/about-me", { text: "I run a small candle shop and like short answers." });
    await api("PUT", "/api/house-rules", { text: "Always answer in plain English.", enabled: true });
    await api("POST", "/api/whats-new/seen", { version: "0.1.60" });
    // A conversation, a room, a routine run and a webhook.
    let tag = `INVENTORY_TURN_${++sequence}`;
    await api("POST", `/api/bots/${moss.id}/messages`, { threadId: moss.threadId, text: `Please answer briefly. ${tag}` });
    await turnFinished(tag);
    const room = (await api("POST", "/api/groups", { name: "Shop room", memberIds: [moss.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: moss.id } } })).group;
    tag = `INVENTORY_TURN_${++sequence}`;
    await api("POST", `/api/groups/${room.id}/messages`, { text: `Please answer briefly. ${tag}` });
    await turnFinished(tag);
    const routine = (await api("POST", "/api/routines", { botId: moss.id, name: "Stock check", prompt: `Please answer briefly. INVENTORY_ROUTINE`, schedule: { type: "once", at: Date.now() + 3_600_000 } })).routine;
    await api("POST", `/api/routines/${routine.id}/run`, {});
    await turnFinished("INVENTORY_ROUTINE");
    await api("POST", "/api/webhooks", { name: "Inbound", prompt: "Handle the event", botId: moss.id });
    // Skills the owner imports, and one switched on for the bot.
    expect((await call("POST", "/api/skills/import", { zip: await skillZip(), label: "invoice-chaser.zip" })).status).toBe(201);
    await api("PUT", `/api/skills/collection:invoice-chaser/bots/${moss.id}`, { on: true });
    await api("PUT", `/api/thread-snoozes/${moss.threadId}`, { until: Date.now() + 3_600_000 });
    // Startup and shutdown write too.
    await fixture.restart();
    headers["x-murage-surface-secret"] = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    await fixture.stop();

    const data = fixture.info.dataDir;
    const created = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const present = readdirSync(data);
    // The recorder must actually see writes, or this test proves nothing.
    expect(created).toEqual(expect.arrayContaining(["about-me.md", "house-rules.md", "whats-new.json", "bots.json", "skill-collection"]));
    expect(unclassifiedDataDirNames([...created, ...present].filter(name => !HARNESS.has(name)))).toEqual([]);

    for (const name of HARNESS) rmSync(join(data, name), { recursive: true, force: true });
    const parent = mkdtempSync(join(tmpdir(), "murage-data-dir-stage-"));
    try {
      await withOfflineInstallation(data, async installation => {
        const stage = await stageInstallationStateWhileOwned(installation, parent);
        const inventory = await inventoryFidelity(installation, stage, { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" });
        inventory.assertUnchanged();
        for (const name of ["about-me.md", "house-rules.md", "whats-new.json", "bots.json"]) expect(stage.manifest.files.map(file => file.path), name).toContain(name);
        expect(stage.manifest.files.some(file => file.path.split(/[\\/]/)[0] === "skill-collection")).toBe(true);
      });
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 180000);
});
