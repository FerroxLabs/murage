// Q1-T5 joined scenario for the 0.1.52 integration candidate.
//
// One isolated fixture per docs/verification/README.md (temporary data dir
// and HOME, free port pair, the suite's fake engine only, the server suite's
// image provider fixture intercepting every image origin). Nothing here
// touches a real app, ~/.murage, a provider or the network.
//
// The frozen matrix, in order:
//   1. Fresh isolated profile (memory active, as a fresh installation is) with
//      the fixture image provider selected.
//   2. Two bots run at the same time: the reporter holds a turn that has
//      already written outputs/weekly-report.md (published only when the
//      turn settles); the artist holds an authority turn and, through the
//      real mounted agents MCP proxy, generates one image in one turn and, in
//      a second held turn, prepares it as a reference (IMG-SEED) and edits
//      with it — the provider receives the exact reference bytes, every call
//      is approved and billed once (one image attempt per turn by design).
//   3. The artist is stopped: its held turn is interrupted and the turn's
//      capability is revoked (the open MCP session is refused), while the
//      reporter is still running; the reporter then finishes and its report
//      becomes one saved version, one receipt and one host card.
//   4. The owner edits the report through the workspace write route, which
//      keeps the replaced revision as a saved version.
//   5. The harness is restarted over the same data: bots, transcripts, host
//      cards, attachments, saved versions (bytes by sha256), the working
//      file and its revision, receipts, memory sources and the provider call
//      count are all preserved, no provider call happens, and both bots take
//      a new turn.
//
// Usage: node --experimental-strip-types scripts/qualify-0152-candidate.ts [--out <json>]
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer } from "./control-murage.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const outIndex = process.argv.indexOf("--out");
const OUT = resolve(outIndex > 0 ? process.argv[outIndex + 1]! : ".planning/0152-candidate-joined.json");

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const FIXTURE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const FIXTURE_SHA = sha256(FIXTURE_PNG);
const RELATIVE_PATH = "outputs/weekly-report.md";
const REPORT = `# Weekly report\n\nThree updates this week.\n\n- Written by the fixture engine to ${RELATIVE_PATH}\n`;
const EDITED = "# Weekly report\n\nThree updates this week.\n\nReviewed by the owner before the restart.\n";

interface Bot { id: string; threadId: string; name: string }
interface Mount { command: string; args: string[]; env: Record<string, string> }
type Step = { step: string; ok: boolean; detail?: unknown; at: string };

const steps: Step[] = [];
const incidents: string[] = [];
function record(step: string, detail?: unknown) { steps.push({ step, ok: true, detail, at: new Date().toISOString() }); console.log(`ok  ${step}`); }
async function poll(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 15_000, every = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, every));
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── the fixture ──────────────────────────────────────────────────────────
const preload = pathToFileURL(join(ROOT, "server", "testing", "search-fetch-preload.mjs")).href;
const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: [
  "import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';",
  "import {join} from 'node:path';",
  `await import(${JSON.stringify(preload)});`,
  "const dataDir = process.env.MURAGE_DATA_DIR;",
  "const gateDir = join(dataDir, 'finish-fake'); mkdirSync(gateDir, {recursive: true});",
  "process.env.FAKE_CLAUDE_FINISH_GATE_DIR = gateDir;",
  "const configPath = join(dataDir, 'config.json'); const config = JSON.parse(readFileSync(configPath, 'utf8'));",
  "const cli = config.instances.verification.config.cli;",
  // Two engines, one per bot, each with its own dump file so concurrent turns never overwrite each other's evidence.
  "config.instances.reporter = { driver: 'claudeAgent', displayName: 'Reporter fixture', environment: { FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_REPLY_GATE: join(dataDir, 'reporter-gate'), FAKE_CLAUDE_DUMP: join(dataDir, 'dump-reporter.json'), FAKE_CLAUDE_DUMP_EACH_TURN: '1' }, config: { cli } };",
  "config.instances.artist = { driver: 'claudeAgent', displayName: 'Artist fixture', environment: { FAKE_CLAUDE_DUMP: join(dataDir, 'dump-artist.json'), FAKE_CLAUDE_DUMP_EACH_TURN: '1' }, config: { cli } };",
  "writeFileSync(configPath, JSON.stringify(config, null, 2));",
  "writeFileSync(join(dataDir, 'candidate-environment.json'), JSON.stringify(process.env), {mode: 0o600});",
].join("\n") });
const dataDir = fixture.info.dataDir;
const logs: string[] = [fixture.info.logPath];
const serverEnv = JSON.parse(readFileSync(join(dataDir, "candidate-environment.json"), "utf8")) as Record<string, string>;
let headers: Record<string, string> = {};
const proxies: ChildProcess[] = [];

async function ownerProof() {
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}
async function request(path: string, method = "GET", body?: unknown) {
  return fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
}
async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const response = await request(path, method, body);
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text().catch(() => "")}`);
  return await response.json();
}
async function bytesOf(path: string, withProof = true): Promise<Buffer> {
  const response = await fetch(fixture.info.url + path, { headers: withProof ? headers : {}, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, `GET ${path}`);
  return Buffer.from(await response.arrayBuffer());
}
const botsWithMessages = async () => (await api("/api/bots?messages=200")).bots as any[];
const messagesOf = async (who: Bot) => (await botsWithMessages()).find(item => item.id === who.id).messages as any[];
const busy = async (who: Bot) => Boolean((await api("/api/bots?messages=0")).bots.find((item: Bot) => item.id === who.id)?.busy);
const artifactsOf = async (who: Bot) => (await api(`/api/artifacts?botId=${who.id}&pageSize=50`)).items as any[];
const describe = async (id: string) => (await api(`/api/artifacts/${id}`)).artifact as any;
const hostCards = async (who: Bot) => (await messagesOf(who)).filter(message => message.artifactIds?.length);
const imageReceipt = () => JSON.parse(readFileSync(join(dataDir, "image-fixture-calls.json"), "utf8")) as { calls: number; url: string; model: string; references: number; referenceHashes: string[] };
const attachmentsDir = () => join(dataDir, "attachments");
const pngsOnDisk = (directory: string) => existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".png")).sort() : [];
function db<T>(work: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
  try { return work(database); } finally { database.close(); }
}
const receiptRows = (botId: string) => db(database => database.prepare("SELECT producer, path_token, sha256, stage, artifact_id, attachment_id, message_id, error_category FROM output_publications WHERE bot_id=? ORDER BY created_at, id").all(botId) as Array<Record<string, string | null>>);
const memorySources = () => db(database => database.prepare("SELECT id, thread_id, revision, content_hash, state FROM memory_sources ORDER BY id").all() as Array<Record<string, unknown>>);
const memoryMode = () => db(database => String(database.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode));

/** The harness's dispatch-preparation incident the F4-T7/F5-T5 proofs also
 * saw (MEMORY_CONTEXT_REVOKED before the engine started). Counted, never
 * hidden: a retry is an incident in the evidence. */
const MEMORY_REVOKED = "error: MEMORY_CONTEXT_REVOKED";
async function revokedBeforeEngine(who: Bot): Promise<boolean> {
  if (await busy(who)) return false;
  const last = (await messagesOf(who)).at(-1);
  return last?.kind === "activity" && last?.tool?.name === MEMORY_REVOKED;
}
async function retry(what: string, attempt: number) {
  assert.ok(attempt < 3, `${what} ended with ${MEMORY_REVOKED} three times; log ${fixture.info.logPath}`);
  const note = `${what} ended with ${MEMORY_REVOKED} before the engine started (attempt ${attempt}); sent again after 1500 ms`;
  incidents.push(note); console.warn(`incident ${note}`);
  await sleep(1_500);
}
const reporterGate = () => join(dataDir, "reporter-gate");
const dumpOf = (name: string) => join(dataDir, `dump-${name}.json`);

/** Reporter: a gated turn; returns once `ready()` holds while the turn is running. */
async function holdReporter(who: Bot, text: string, ready: () => boolean) {
  await poll(`${who.name} idle`, async () => !(await busy(who)), 10_000);
  rmSync(reporterGate(), { force: true });
  for (let attempt = 1; ; attempt++) {
    rmSync(dumpOf("reporter"), { force: true });
    assert.equal((await request(`/api/bots/${who.id}/messages`, "POST", { text })).status, 202);
    const deadline = Date.now() + 30_000; let revoked = false;
    while (!ready()) {
      if (await revokedBeforeEngine(who)) { revoked = true; break; }
      assert.ok(Date.now() < deadline, `the reporter engine never reached its gate for ${JSON.stringify(text)}; log ${fixture.info.logPath}`);
      await sleep(100);
    }
    if (!revoked) return;
    await retry(`${who.name}'s turn ${JSON.stringify(text)}`, attempt);
  }
}
async function releaseReporter(who: Bot) {
  writeFileSync(reporterGate(), "go");
  try { await poll(`${who.name} settled`, async () => !(await busy(who)), 30_000); } finally { rmSync(reporterGate(), { force: true }); }
}
async function plainReporterTurn(who: Bot, text: string) {
  writeFileSync(reporterGate(), "go");
  try {
    for (let attempt = 1; ; attempt++) {
      assert.equal((await request(`/api/bots/${who.id}/messages`, "POST", { text })).status, 202);
      await poll(`${who.name} settled`, async () => !(await busy(who)), 40_000);
      if (!(await revokedBeforeEngine(who))) return;
      await retry(`${who.name}'s turn ${JSON.stringify(text)}`, attempt);
    }
  } finally { rmSync(reporterGate(), { force: true }); }
}
/** Artist: a turn that completes with a normal result. The fake engine holds
 * any prompt carrying the hold directive, and with memory active the bundle
 * quotes the artist's earlier held turns, so the engine is released through
 * its per-process finish gate once it has the prompt. */
async function finishArtistTurn(who: Bot, text: string) {
  for (let attempt = 1; ; attempt++) {
    rmSync(dumpOf("artist"), { force: true });
    assert.equal((await request(`/api/bots/${who.id}/messages`, "POST", { text })).status, 202);
    const deadline = Date.now() + 30_000; let revoked = false;
    for (;;) {
      try { const dump = JSON.parse(readFileSync(dumpOf("artist"), "utf8")); if (dump.pid) { writeFileSync(join(dataDir, "finish-fake", String(dump.pid)), "finish"); break; } } catch { /* not written yet */ }
      if (await revokedBeforeEngine(who)) { revoked = true; break; }
      assert.ok(Date.now() < deadline, `the artist engine never received ${JSON.stringify(text)}; log ${fixture.info.logPath}`);
      await sleep(100);
    }
    if (!revoked) { await poll(`${who.name} settled`, async () => !(await busy(who)), 40_000); return; }
    await retry(`${who.name}'s turn ${JSON.stringify(text)}`, attempt);
  }
}
/** Artist: holds an authority turn open and returns the agents MCP mount the driver wrote for it. */
async function holdArtist(who: Bot, attempt = 1): Promise<Mount> {
  await poll(`${who.name} idle`, async () => !(await busy(who)), 10_000);
  rmSync(dumpOf("artist"), { force: true });
  assert.equal((await request(`/api/bots/${who.id}/messages`, "POST", { text: "__fixture_hold_authority__" })).status, 202);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const dump = JSON.parse(readFileSync(dumpOf("artist"), "utf8"));
      const candidate = dump.mcpConfig?.mcpServers?.agents as Mount | undefined;
      if (candidate?.env?.MURAGE_COMMS_TOKEN && candidate.env.MURAGE_BOT_ID === who.id) return candidate;
    } catch { /* not written yet */ }
    if (await revokedBeforeEngine(who)) { await retry(`${who.name}'s held turn`, attempt); return holdArtist(who, attempt + 1); }
    assert.ok(Date.now() < deadline, `the artist engine never received its held turn; log ${fixture.info.logPath}`);
    await sleep(100);
  }
}
async function stopProcess(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(r => child.once("close", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await closed; } finally { clearTimeout(timer); }
}
/** The real mounted MCP proxy, started the way the driver starts it. */
function connect(mount: Mount) {
  const proxy = spawn(mount.command, mount.args, { env: { ...serverEnv, ...mount.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, any>(); let buffered = "", stderr = "";
  proxy.stdout!.on("data", chunk => {
    buffered += String(chunk);
    for (;;) {
      const end = buffered.indexOf("\n"); if (end < 0) break;
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try { const value = JSON.parse(line); if (typeof value.id === "number") replies.set(value.id, value); } catch {}
    }
  });
  proxy.stderr!.on("data", chunk => { stderr += String(chunk); });
  let next = 1;
  const send = (method: string, params: Record<string, unknown>) => { const id = next++; proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return id; };
  const answer = async (id: number, what: string, timeoutMs: number) => { await poll(`MCP ${what} #${id} (stderr: ${stderr.slice(-300)})`, () => replies.has(id), timeoutMs); return replies.get(id); };
  const rpc = async (method: string, params: Record<string, unknown>) => answer(send(method, params), method, 20_000);
  const call = (name: string, args: Record<string, unknown>) => { const id = send("tools/call", { name, arguments: args }); return answer(id, name, 30_000).then(reply => (reply.result ?? { isError: true, content: [{ text: JSON.stringify(reply.error) }] }) as { isError?: boolean; content: Array<{ text: string }> }); };
  return { proxy, rpc, call, close: () => stopProcess(proxy) };
}
async function session(mount: Mount) {
  const client = connect(mount);
  await client.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "candidate-0152", version: "1" } });
  return client;
}
async function approveNext(who: Bot, title: string) {
  let card: any;
  await poll(`${who.name}'s ${title} card`, async () => { card = (await messagesOf(who)).find(message => message.card?.tool === "generate_image" && !message.card.answered); return Boolean(card); }, 15_000);
  assert.equal(card.card.title, title);
  assert.equal((await request(`/api/bots/${who.id}/respond`, "POST", { requestId: card.card.requestId, behavior: "allow" })).status, 200);
  return card;
}

let reporter: Bot, artist: Bot;
let exitCode = 0;
try {
  // ── 1. fresh isolated profile ─────────────────────────────────────────
  await ownerProof();
  assert.equal((await fetch(fixture.info.url + "/api/memory/status")).status, 404, "memory owner routes refuse a bare request");
  // A fresh profile seeds its own starter bot; only the two below take part.
  const seeded = (await api("/api/bots?messages=0")).bots.map((item: any) => ({ id: item.id, name: item.name }));
  reporter = (await api("/api/bots", "POST", { name: "Candidate reporter", modelSelection: { instanceId: "reporter", model: "sonnet" } })).bot;
  artist = (await api("/api/bots", "POST", { name: "Candidate artist", modelSelection: { instanceId: "artist", model: "sonnet" } })).bot;
  // A fresh installation starts with memory active (server/database.ts), so
  // every turn below goes through the memory dispatch preparation.
  const memoryOn = await api("/api/memory/status");
  assert.equal(memoryOn.mode, "active");
  assert.equal((await request("/api/config?secretStorage=external", "PATCH", { imageGen: { key: "fixture-image-key" } })).status, 200);
  const settings = await api("/api/images/settings", "POST", { enabled: true, connectionId: "openai", model: "gpt-image-2" });
  assert.deepEqual(settings.selected, { connectionId: "openai", model: "gpt-image-2" });
  record("1. fresh isolated profile: two bots on two fixture engines, memory active, fixture image provider selected", { dataDir, url: fixture.info.url, seeded, reporter: reporter.id, artist: artist.id, installationId: memoryOn.installationId });

  // ── 2. two bots at once ───────────────────────────────────────────────
  await plainReporterTurn(reporter, "Warm up.");
  const workspace = (await api(`/api/artifacts/workspace?botId=${reporter.id}&threadId=${reporter.threadId}`)).path as string;
  const reportPath = join(workspace, ...RELATIVE_PATH.split("/"));
  assert.ok(!existsSync(reportPath));
  await holdReporter(reporter, `Write the weekly report. __fixture_write_output__:${RELATIVE_PATH}`, () => existsSync(reportPath));
  assert.equal(readFileSync(reportPath, "utf8"), REPORT);
  assert.equal(await busy(reporter), true);
  assert.deepEqual(await hostCards(reporter), [], "nothing is published while the turn runs");
  assert.deepEqual(await artifactsOf(reporter), []);

  const firstMount = await holdArtist(artist);
  const both = (await api("/api/bots?messages=0")).bots.map((item: any) => ({ id: item.id, busy: item.busy }));
  assert.equal(both.find((item: any) => item.id === reporter.id).busy, true);
  assert.equal(both.find((item: any) => item.id === artist.id).busy, true);
  record("2a. both bots are busy at the same time: the reporter holds a turn that has already written the report; the artist holds an authority turn", { reportOnDisk: sha256(REPORT), both });

  const firstClient = await session(firstMount);
  assert.ok(!existsSync(join(dataDir, "image-fixture-calls.json")), "no provider call before the first approval");
  const pendingGenerate = firstClient.call("generate_image", { request_id: "candidate-generate", prompt: "Synthetic candidate fixture", connection_id: "openai", model: "gpt-image-2" });
  await approveNext(artist, "Approve image generation");
  const generated = await pendingGenerate;
  assert.ok(!generated.isError, generated.content?.[0]?.text);
  const generatedPayload = JSON.parse(generated.content[0].text) as { artifact: { id: string; path: string; referenceId: string; artifactId?: string; filesError?: string }; metadata: Record<string, unknown> };
  const { referenceId, artifactId: generatedArtifactId, path: retainedPath } = generatedPayload.artifact;
  assert.ok(generatedArtifactId, "the saved version is named in the tool result");
  assert.equal(generatedPayload.artifact.filesError, undefined);
  assert.equal(imageReceipt().calls, 1);
  assert.equal(imageReceipt().url, "https://api.openai.com/v1/images/generations");
  assert.deepEqual(pngsOnDisk(attachmentsDir()), [referenceId]);
  assert.equal(sha256(readFileSync(retainedPath)), FIXTURE_SHA);
  assert.equal(sha256(await bytesOf(`/api/artifacts/${generatedArtifactId}/download`)), FIXTURE_SHA);
  assert.equal(sha256(await bytesOf(`/api/attachments/${referenceId}`, false)), FIXTURE_SHA);
  record("2b. the artist's approved generation is one attachment, one retained original and one saved version, billed once", { referenceId, artifactId: generatedArtifactId, receipt: imageReceipt() });

  // One image attempt per turn (server/image-operations.ts), so the edit is
  // its own held turn; the first turn ends the way a finished turn does.
  await firstClient.close();
  assert.equal((await request(`/api/bots/${artist.id}/interrupt`, "POST")).status, 200);
  await poll("artist idle between image turns", async () => !(await busy(artist)), 10_000);
  const mount = await holdArtist(artist);
  const client = await session(mount);
  assert.equal(await busy(reporter), true, "the reporter is still holding its turn");

  // IMG-SEED: the generated image becomes a reference (by attachment id and by
  // saved version pinned to its sha256), the edit is approved with its
  // reference count, and the provider receives the exact reference bytes.
  const references = await client.call("resolve_image_reference", { sources: [{ attachment_id: referenceId }, { artifact_id: generatedArtifactId, sha256: FIXTURE_SHA }] });
  assert.ok(!references.isError, references.content?.[0]?.text);
  const prepared = JSON.parse(references.content[0].text).references as Array<{ id: string; sha256: string; source: string }>;
  assert.deepEqual(prepared.map(item => item.sha256), [FIXTURE_SHA, FIXTURE_SHA]);
  assert.equal(prepared[0]!.id, referenceId);
  assert.equal(imageReceipt().calls, 1, "preparing references bills nothing");
  const desktopReference = await api("/api/media/reference", "POST", { threadId: artist.threadId, source: { kind: "attachment", attachmentId: referenceId } });
  assert.equal(desktopReference.reference.sha256, FIXTURE_SHA);
  const pendingEdit = client.call("generate_image", { request_id: "candidate-edit", prompt: "Edit the candidate fixture", operation: "edit", reference_ids: [prepared[0]!.id] });
  const editCard = await approveNext(artist, "Approve image edit");
  assert.match(String(editCard.card.subtitle), /1 reference image/);
  const edited = await pendingEdit;
  assert.ok(!edited.isError, edited.content?.[0]?.text);
  const editedPayload = JSON.parse(edited.content[0].text) as { artifact: { id: string; referenceId: string; artifactId?: string }; metadata: { operation: string; referenceCount: number } };
  const editReceipt = imageReceipt();
  assert.deepEqual({ calls: editReceipt.calls, url: editReceipt.url, references: editReceipt.references, referenceHashes: editReceipt.referenceHashes }, { calls: 2, url: "https://api.openai.com/v1/images/edits", references: 1, referenceHashes: [FIXTURE_SHA] });
  assert.deepEqual(editedPayload.metadata, { ...editedPayload.metadata, operation: "edit", referenceCount: 1 });
  assert.ok(editedPayload.artifact.artifactId);
  assert.deepEqual(pngsOnDisk(attachmentsDir()), [referenceId, editedPayload.artifact.referenceId].sort());
  assert.equal(await busy(reporter), true, "the reporter is still running through all of this");
  record("2c. IMG-SEED: the generated image is prepared as a reference by attachment id and by pinned saved version, the edit is approved naming one reference, the provider receives the exact bytes, billed once more", { prepared, editSubtitle: editCard.card.subtitle, receipt: editReceipt, editedArtifactId: editedPayload.artifact.artifactId });

  // ── 3. stop and revoke the artist while the reporter continues ────────
  const bearer = mount.env.MURAGE_COMMS_TOKEN;
  assert.equal((await fetch(`${fixture.info.url}/api/internal/image-models`, { headers: { authorization: `Bearer ${bearer}` } })).status, 200, "the held turn's capability works before the stop");
  assert.equal((await request(`/api/bots/${artist.id}/interrupt`, "POST")).status, 200);
  await poll("artist stopped", async () => !(await busy(artist)), 10_000);
  assert.equal((await fetch(`${fixture.info.url}/api/internal/image-models`, { headers: { authorization: `Bearer ${bearer}` } })).status, 401, "the stopped turn's capability is revoked");
  const afterStop = await client.call("list_image_models", {});
  assert.equal(afterStop.isError, true, "the open MCP session is refused after the stop");
  assert.equal(imageReceipt().calls, 2);
  assert.equal(await busy(reporter), true, "the reporter is unaffected by the artist's stop");
  await client.close();
  record("3a. the artist is stopped: interrupt settles it, its turn capability is revoked (desktop route 401, open MCP session refused) while the reporter is still busy", { afterStop: afterStop.content?.[0]?.text?.slice(0, 200) });

  await releaseReporter(reporter);
  let card: any;
  await poll("reporter host card", async () => { card = (await hostCards(reporter))[0]; return Boolean(card); }, 15_000);
  assert.equal(card.text, "Saved file: weekly-report.md");
  assert.equal(card.artifactIds.length, 1);
  const reportArtifactId = card.artifactIds[0] as string;
  const reportArtifact = await describe(reportArtifactId);
  assert.equal(reportArtifact.sha256, sha256(REPORT));
  assert.equal(reportArtifact.producer, "shell-output");
  assert.equal(reportArtifact.relativePath, RELATIVE_PATH);
  assert.equal(reportArtifact.sourceState, "current");
  const reporterReceipts = receiptRows(reporter.id);
  assert.equal(reporterReceipts.length, 1);
  assert.deepEqual({ ...reporterReceipts[0] }, { ...reporterReceipts[0], producer: "shell-output", path_token: RELATIVE_PATH, sha256: sha256(REPORT), stage: "registered", artifact_id: reportArtifactId, message_id: card.id, error_category: null });
  assert.equal(sha256(await bytesOf(`/api/artifacts/${reportArtifactId}/download`)), sha256(REPORT));
  assert.deepEqual((await artifactsOf(reporter)).map(item => item.id), [reportArtifactId]);
  assert.equal((await artifactsOf(artist)).some(item => item.id === reportArtifactId), false);
  record("3b. the reporter finishes: the shell-written report is one saved version, one registered receipt and one host card", { reportArtifactId, cardMessageId: card.id, receipt: reporterReceipts[0] });

  // ── 4. the owner edits the report; the replaced revision is kept ──────
  const read = await api(`/api/workspace-files/read?botId=${reporter.id}&threadId=${reporter.threadId}&path=${encodeURIComponent(RELATIVE_PATH)}`);
  assert.equal(read.content, REPORT);
  // The reporter is idle and its card is up; the write must be admitted now.
  // A 423 here would mean a writer lease outlived the turn — recorded, never
  // waited out silently.
  const writeRequest = { scope: { botId: reporter.id, threadId: reporter.threadId }, relativePath: RELATIVE_PATH, baseRevision: read.revision, requestId: "candidate-edit-1", content: EDITED, bom: false };
  let writeResponse = await request("/api/workspace-files/write", "POST", writeRequest);
  if (writeResponse.status === 423) {
    const refusal = await writeResponse.text(); const startedAt = Date.now();
    await poll("workspace write admitted after the bot settled", async () => { writeResponse = await request("/api/workspace-files/write", "POST", writeRequest); return writeResponse.status !== 423; }, 15_000, 250);
    incidents.push(`the owner's save was refused with 423 (${refusal}) for ${Date.now() - startedAt} ms after the reporter had settled and its card was shown`);
    console.warn(`incident ${incidents.at(-1)}`);
  }
  assert.ok(writeResponse.ok, `POST /api/workspace-files/write: ${writeResponse.status} ${await writeResponse.clone().text()}`);
  const receipt = await writeResponse.json();
  assert.equal(receipt.previousRevision, read.revision);
  assert.equal(readFileSync(reportPath, "utf8"), EDITED);
  const afterEdit = await artifactsOf(reporter);
  assert.equal(afterEdit.length, 2, "the replaced revision is kept as a saved version");
  const kept = afterEdit.find(item => item.id !== reportArtifactId)!;
  assert.equal(kept.sha256, sha256(REPORT));
  assert.equal((await describe(reportArtifactId)).sourceState, "changed");
  const stale = await request("/api/workspace-files/write", "POST", { scope: { botId: reporter.id, threadId: reporter.threadId }, relativePath: RELATIVE_PATH, baseRevision: read.revision, requestId: "candidate-edit-stale", content: "clobber\n", bom: false });
  assert.equal(stale.status, 409, "a write on a stale revision is refused");
  assert.equal(readFileSync(reportPath, "utf8"), EDITED);
  record("4. the owner's edit lands exactly, keeps the replaced revision as a saved version, and a stale-revision write is refused", { revisionBefore: read.revision, revisionAfter: receipt.revision, keptArtifactId: kept.id, staleStatus: stale.status });

  // ── 5. restart over the same data ─────────────────────────────────────
  const snapshot = async () => {
    const bots = await botsWithMessages();
    const artifacts = { reporter: await artifactsOf(reporter), artist: await artifactsOf(artist) };
    const downloads: Record<string, string> = {};
    for (const item of [...artifacts.reporter, ...artifacts.artist]) downloads[item.id] = sha256(await bytesOf(`/api/artifacts/${item.id}/download`));
    return {
      // A bot that never ran a turn carries no busy field until a restart resets it to false.
      bots: bots.map(item => ({ id: item.id, threadId: item.threadId, name: item.name, busy: Boolean(item.busy), messages: item.messages.length, messageIds: item.messages.map((message: any) => message.id) })),
      hostCards: { reporter: (await hostCards(reporter)).map(message => ({ id: message.id, text: message.text, artifactIds: message.artifactIds })) },
      attachments: { onDisk: pngsOnDisk(attachmentsDir()), served: { [referenceId]: sha256(await bytesOf(`/api/attachments/${referenceId}`, false)), [editedPayload.artifact.referenceId]: sha256(await bytesOf(`/api/attachments/${editedPayload.artifact.referenceId}`, false)) } },
      artifacts: { reporter: artifacts.reporter.map(item => ({ id: item.id, sha256: item.sha256, producer: item.producer ?? null })).sort((a, b) => a.id.localeCompare(b.id)), artist: artifacts.artist.map(item => ({ id: item.id, sha256: item.sha256, producer: item.producer ?? null })).sort((a, b) => a.id.localeCompare(b.id)) },
      downloads,
      workingFile: { content: readFileSync(reportPath, "utf8"), revision: (await api(`/api/workspace-files/read?botId=${reporter.id}&threadId=${reporter.threadId}&path=${encodeURIComponent(RELATIVE_PATH)}`)).revision },
      receipts: { reporter: receiptRows(reporter.id), artist: receiptRows(artist.id) },
      memory: { mode: memoryMode(), sources: memorySources() },
      providerCalls: imageReceipt().calls,
    };
  };
  const before = await snapshot();
  assert.ok(before.memory.sources.length >= 2, `memory capture recorded the turns (${before.memory.sources.length} sources)`);
  assert.equal(before.memory.mode, "active");
  await fixture.restart();
  logs.push(fixture.info.logPath);
  await ownerProof();
  const after = await snapshot();
  assert.deepEqual(after, before, "everything survives the restart byte for byte");
  const status = await api("/api/memory/status");
  assert.equal(status.mode, "active");
  record("5a. after a real harness restart over the same data, bots, transcripts, host cards, attachments, saved versions and their bytes, the working file and its revision, receipts, memory sources and the provider call count are identical", { bots: after.bots.map(item => ({ id: item.id, messages: item.messages })), artifacts: after.artifacts, memorySources: after.memory.sources.length, providerCalls: after.providerCalls });

  await finishArtistTurn(artist, "After the restart.");
  await plainReporterTurn(reporter, "After the restart.");
  const finalBots = await botsWithMessages();
  for (const who of [reporter, artist]) {
    const item = finalBots.find(bot => bot.id === who.id);
    assert.equal(item.busy, false);
    assert.ok(item.messages.length > before.bots.find((bot: any) => bot.id === who.id)!.messages, `${who.name} took a new turn after the restart`);
  }
  assert.equal(imageReceipt().calls, 2, "no provider call during or after the restart");
  assert.equal(readFileSync(reportPath, "utf8"), EDITED);
  assert.equal((await artifactsOf(reporter)).length, 2);
  record("5b. both bots take a new turn after the restart; the edited report and its two saved versions are untouched and the provider was not called again", { messages: finalBots.map(item => ({ id: item.id, messages: item.messages.length })) });
} catch (error) {
  exitCode = 1;
  let state: unknown;
  try { state = (await botsWithMessages()).map(item => ({ id: item.id, name: item.name, busy: item.busy, activity: item.activity, last: item.messages.slice(-5).map((message: any) => ({ role: message.role, kind: message.kind, text: message.text?.slice(0, 120), tool: message.tool?.name })) })); } catch (stateError) { state = String(stateError); }
  steps.push({ step: "FAILED", ok: false, detail: { error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error), state }, at: new Date().toISOString() });
  console.error(error, JSON.stringify(state, null, 1));
} finally {
  for (const proxy of proxies) await stopProcess(proxy);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ scenario: "0152 Q1-T5 joined candidate", ok: exitCode === 0, node: process.version, platform: process.platform, dataDir, logs, incidents, steps }, null, 2) + "\n");
  console.log(`evidence ${OUT}`);
  await fixture.close();
}
process.exit(exitCode);
