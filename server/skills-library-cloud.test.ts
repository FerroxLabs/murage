// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real Cloud authentication, route policy, one-use CP proofs and dispatcher.
// Only the control plane and engine are fakes; all writes use an isolated home.
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { CloudSessions } from "./cloud-sessions.ts";
import { routeActDigest, stepPurpose } from "./cloud-request-auth.ts";
import { skillActDigest } from "./cloud-home/owner-code.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const origin = "https://home.example.test";
const cp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const library = mkdtempSync(join(tmpdir(), "murage-library-cloud-"));
let fixture: VerificationServer, db: DatabaseSync, cookie: string, deviceId: string, chatCookie: string;
const desktopKey = generateKeyPairSync("ed25519");
let desktopCookie: string, desktopId: string, environmentId: string, phoneCookie: string, phoneId: string;
const createdBots: string[] = [];
const noLimitsBot = { id: randomUUID(), threadId: randomUUID(), name: "No limits library fixture", title: "", description: "",
  modelSelection: { instanceId: "verification", model: "" }, resumeCursors: {}, createdAt: Date.now(),
  noLimits: true, fullAccess: true, autoApprove: true, noLimitsAcknowledgedAt: Date.now() };

async function api(method: string, path: string, body?: unknown, proof?: string, auth = cookie, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(fixture.info.url + path, { method, headers: {
      host: "home.example.test", origin, cookie: auth, "content-type": "application/json",
      ...(encoded ? { "content-length": String(Buffer.byteLength(encoded)) } : {}),
      ...(proof ? { "x-murage-owner-proof": proof } : {}),
      ...extra,
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.end(encoded);
  });
}

function proof(act: string) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ type: "murage-owner-act-v1", homeId: "fixture-home", generation: 1,
    account: "fixture-owner", deviceId, act, nonce: randomUUID().replace(/-/g, ""), issuedAt: now - 1000, expiresAt: now + 119_000 })).toString("base64url");
  const signature = sign("sha256", Buffer.from(payload), { key: cp.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return Buffer.from(JSON.stringify({ payload, signature })).toString("base64url");
}
async function factorApi(method: string, path: string, body: unknown, auth = desktopCookie, id = desktopId) {
  const purpose = stepPurpose(method, path, body);
  const challenge = await api("POST", "/api/cloud/challenge", { deviceId: id, purpose }, undefined, auth);
  expect(challenge.status).toBe(200);
  const at = Date.now();
  const signature = sign(null, Buffer.from(`murage:${environmentId}:${id}:${purpose}:${challenge.body.challenge}:${at}`), desktopKey.privateKey).toString("base64url");
  const assertion = Buffer.from(JSON.stringify({ challenge: challenge.body.challenge, at, signature })).toString("base64url");
  return api(method, path, body, undefined, auth, { "x-murage-step-up": assertion });
}
function challengedAct(answer: { status: number; body: any }) {
  expect(answer).toMatchObject({ status: 403, body: { code: "email_code", label: "new_skill", actToken: expect.any(String) } });
  return JSON.parse(Buffer.from(answer.body.actToken.split(".")[0], "base64url").toString()).act as string;
}
async function copyAndBot() {
  const created = await api("POST", "/api/bots", { name: "Library browser fixture" });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  createdBots.push(bot.id);
  return { bot, copy: await copySkill() };
}
async function copySkill() {
  const path = "/api/skills/library:guide-one/duplicate";
  const copied = await api("POST", path, {}, proof(challengedAct(await api("POST", path, {}))));
  expect(copied.status).toBe(201);
  return copied.body.skill.ref as string;
}

beforeAll(async () => {
  for (let i = 0; i < 12; i++) {
    const id = i === 0 ? "guide-one" : `guide-${i}`;
    mkdirSync(join(library, id));
    writeFileSync(join(library, id, "manifest.json"), JSON.stringify({ id, name: id === "guide-one" ? "Guide One" : id, version: "1.0.0", description: "A clear method.", triggerTerms: ["testing"], defaultEnabled: false, requiredCapabilities: [] }));
    writeFileSync(join(library, id, "SKILL.md"), `---\nname: ${id}\ndescription: A clear method.\n---\nDraft a clear response.\n`);
  }
  const pem = cp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const env = { MURAGE_SKILL_LIBRARY: library, MURAGE_COMPANION_TOKEN: process.env.MURAGE_TEST_DOOR_TOKEN };
  fixture = await launchVerificationServer(process.env, undefined, {
    env,
    cloud: { publicOrigin: origin, bootstrapSecret: "fixture-library-cloud-bootstrap-32-characters" },
    // Cloud homes cannot grant No limits through the physical-computer-only preview; load an already enabled fixture bot.
    instrumentationSource: `const {pathToFileURL}=await import('node:url'); const {join}=await import('node:path'); const {writeFileSync}=await import('node:fs'); writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([${JSON.stringify(noLimitsBot)}])); const control=await import(pathToFileURL(join(process.cwd(),'server/cloud-home/control-state-verification.fixture.mjs')).href); control.installVerificationControl(${JSON.stringify(origin)},${JSON.stringify(pem)});`,
    readyTimeoutMs: 60_000,
  });
  console.info("Library Cloud fixture", JSON.stringify(fixture.info));
  db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const sessions = new CloudSessions(db, undefined, origin);
  environmentId = sessions.environmentId;
  db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','fixture-owner')").run();
  for (const owner of [true, false]) {
    const id = randomUUID(), key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
    db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)")
      .run(id, "fixture-owner", "browser", publicKey, publicKey, Date.now(), Date.now());
    if (owner) {
      deviceId = id;
      const hash = createHash("sha256").update(key.publicKey.export({ type: "spki", format: "der" })).digest("hex");
      db.prepare("INSERT INTO cloud_browser_factors (device,payload,kind,issuedAt,expiresAt,keyHash,stepUpAt) VALUES (?,?,'remembered-owner',?,?,?,?)")
        .run(id, "{}", Date.now(), Date.now() + 86_400_000, hash, Date.now());
    }
    const value = `__Host-murage=${sessions.issue(id).accessToken}`;
    if (owner) cookie = value; else chatCookie = value;
  }
  for (const scope of ["owner-desktop", "owner-phone"] as const) {
    const id = randomUUID(), publicKey = desktopKey.publicKey.export({ type: "spki", format: "pem" }).toString();
    db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)")
      .run(id, "fixture-owner", scope, publicKey, publicKey, Date.now(), Date.now());
    const value = `__Host-murage=${sessions.issue(id).accessToken}`;
    if (scope === "owner-desktop") { desktopId = id; desktopCookie = value; } else { phoneId = id; phoneCookie = value; }
  }
}, 90_000);
afterAll(async () => { db?.close(); await fixture?.close(); await removeTempDir(library); });
afterEach(async () => {
  for (const id of createdBots.splice(0)) expect((await api("PUT", `/api/skills/library:guide-one/bots/${id}`, { on: false })).status).toBe(200);
});

it.each(["/api/library/topics", "/api/library/skills"])("admits an authenticated owner browser at %s", async (path) => {
  const answer = await api("GET", path);
  expect(answer.status).toBe(200);
  if (path.endsWith("topics")) expect(answer.body).toMatchObject({ totalSkills: 12, topics: [{ term: "testing", count: 12 }] });
  else expect(answer.body).toMatchObject({ total: 12, items: expect.arrayContaining([expect.objectContaining({ id: "library:guide-one" })]) });
  expect((await api("GET", path, undefined, undefined, chatCookie)).status).toBe(403);
});

function copyDirectory(copy: string) {
  return join(fixture.info.dataDir, "skill-collection", copy.slice("collection:".length));
}
function tree(directory: string): Record<string, Buffer> {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap((entry): Array<[string, Buffer]> =>
    entry.isDirectory() ? Object.entries(tree(join(directory, entry.name))).map(([path, bytes]) => [`${entry.name}/${path}`, bytes])
      : [[entry.name, readFileSync(join(directory, entry.name))]]));
}
function installationState(botIds: string[]) {
  return { collection: tree(join(fixture.info.dataDir, "skill-collection")),
    bots: botIds.map((id) => tree(join(fixture.info.dataDir, "workspaces", id, "skills"))) };
}
// Independent wire-format oracle: never calls the handler's snapshot/digest helpers.
function installAct(path: string, body: { description: string; body: string }, copy: string, botIds: string[]) {
  const record = JSON.parse(readFileSync(join(fixture.info.dataDir, "skill-collection", "collection.json"), "utf8"))[copy.slice("collection:".length)];
  const files = record.files.filter((p: string) => !record.assetFiles?.includes(p)) as string[];
  files.sort((a, b) => a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a < b ? -1 : a > b ? 1 : 0);
  const chunks = [Buffer.from("skill-install-v1\n")];
  for (const file of files) {
    let bytes = readFileSync(join(copyDirectory(copy), file));
    if (file === "SKILL.md") {
      const header = bytes.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n---[ \t]*(?:\r?\n|$)/)[0]!.split(/\r?\n/).slice(1);
      const kept = header.filter((line) => !/^(?:name|description):/.test(line));
      bytes = Buffer.from(["---", `name: ${copy.slice("collection:".length)}`, `description: ${JSON.stringify(body.description.replace(/\s+/g, " ").trim())}`, ...kept, "---", body.body.replace(/^\s+/, "")].join("\n").replace(/\n*$/, "\n"));
    }
    chunks.push(Buffer.from(`file ${file}\n${bytes.length}\n`), bytes, Buffer.from("\n"));
  }
  for (const asset of [...(record.assetFiles ?? [])].sort()) {
    const bytes = readFileSync(join(copyDirectory(copy), asset));
    chunks.push(Buffer.from(`asset ${asset}\n${bytes.length}\n`), bytes, Buffer.from("\n"));
  }
  chunks.push(Buffer.from("bots\n"), ...[...botIds].sort().map((id) => Buffer.from(`${id}\n`)));
  return skillActDigest(routeActDigest("PUT", path, body), createHash("sha256").update(Buffer.concat(chunks)).digest("hex"));
}

it.each(["frontmatter", "text", "asset"])("binds bytes outside the body: %s", async (changed) => {
  const { bot, copy } = await copyAndBot();
  expect((await api("PUT", `/api/skills/library:guide-one/bots/${bot.id}`, { on: true })).status).toBe(200);
  const dir = copyDirectory(copy), main = join(dir, "SKILL.md");
  writeFileSync(main, readFileSync(main, "utf8").replace("---\n", "---\nlicense: mit\n"));
  writeFileSync(join(dir, "notes.txt"), "A supporting method.\r\n");
  writeFileSync(join(dir, "A.txt"), "Another supporting method.\n");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "z.bin"), Buffer.from([0, 255, 128]));
  writeFileSync(join(dir, "assets", "a.bin"), Buffer.from([254, 1]));
  const recordsPath = join(fixture.info.dataDir, "skill-collection", "collection.json");
  const records = JSON.parse(readFileSync(recordsPath, "utf8"));
  records[copy.slice("collection:".length)].files.push("notes.txt", "A.txt", "assets/z.bin", "assets/a.bin");
  records[copy.slice("collection:".length)].assetFiles = ["assets/z.bin", "assets/a.bin"];
  writeFileSync(recordsPath, JSON.stringify(records));
  const path = `/api/skills/collection/${copy.slice("collection:".length)}`;
  const body = { description: "  My\n method.  ", body: "\n Draft a better response.\n\n" };
  const before = installationState([bot.id]);
  const act = challengedAct(await api("PUT", path, body));
  expect(act).toBe(installAct(path, body, copy, [bot.id]));
  expect(installationState([bot.id])).toEqual(before);
  const target = changed === "frontmatter" ? main : join(dir, changed === "text" ? "notes.txt" : "assets/z.bin");
  const bytes = readFileSync(target);
  writeFileSync(target, changed === "frontmatter" ? Buffer.from(bytes.toString().replace("license: mit", "license: mix")) : Buffer.concat([bytes, Buffer.from([42])]));
  const afterChange = installationState([bot.id]);
  expect((await api("PUT", path, body, proof(act))).status).toBe(403);
  expect(installationState([bot.id])).toEqual(afterChange);
  const nextAct = challengedAct(await api("PUT", path, body));
  expect(nextAct).toBe(installAct(path, body, copy, [bot.id]));
  expect(nextAct).not.toBe(act);
});

it("binds the server's sorted bot set when a bot is added after approval", async () => {
  const { bot: botA, copy } = await copyAndBot();
  const created = await api("POST", "/api/bots", { name: "Second library fixture" });
  expect(created.status).toBe(201);
  const botB = created.body.bot;
  createdBots.push(botB.id);
  const switchPath = `/api/skills/${copy}/bots/${botA.id}`;
  expect((await api("PUT", switchPath, { on: true }, proof(challengedAct(await api("PUT", switchPath, { on: true }))))).status).toBe(200);
  const path = `/api/skills/collection/${copy.slice("collection:".length)}`;
  const body = { description: "Edited method.", body: "Draft a better response." };
  const before = installationState([botA.id, botB.id]);
  const act = challengedAct(await api("PUT", path, body));
  expect(act).toBe(installAct(path, body, copy, [botA.id]));
  expect(installationState([botA.id, botB.id])).toEqual(before);
  expect((await api("PUT", `/api/skills/library:guide-one/bots/${botB.id}`, { on: true })).status).toBe(200);
  const afterEnable = installationState([botA.id, botB.id]);
  expect((await api("PUT", path, body, proof(act))).status).toBe(403);
  expect(installationState([botA.id, botB.id])).toEqual(afterEnable);
  expect(existsSync(join(fixture.info.dataDir, "workspaces", botB.id, "skills", copy.slice("collection:".length)))).toBe(false);
  const nextAct = challengedAct(await api("PUT", path, body));
  expect(nextAct).toBe(installAct(path, body, copy, [botB.id, botA.id]));
  expect(nextAct).not.toBe(act);
});

it("refuses replay without moving any collection bytes or bot switches", async () => {
  const { bot, copy } = await copyAndBot();
  const path = `/api/skills/collection/${copy.slice("collection:".length)}`;
  const body = { description: "Edited method.", body: "Draft a better response." };
  const act = challengedAct(await api("PUT", path, body));
  expect(act).toBe(installAct(path, body, copy, []));
  const header = proof(act);
  expect((await api("PUT", path, body, header)).status).toBe(200);
  expect(challengedAct(await api("PUT", path, body))).toBe(act);
  const before = installationState([bot.id]);
  expect((await api("PUT", path, body, header)).status).toBe(403);
  expect(installationState([bot.id])).toEqual(before);
});

it("No limits still requires the owner-browser handler proof with an empty enabled set", async () => {
  const loaded = await api("GET", `/api/bots/${noLimitsBot.id}?messages=0`);
  expect(loaded).toMatchObject({ status: 200, body: { bot: { id: noLimitsBot.id, noLimits: true, fullAccess: true, autoApprove: true } } });
  const bot = loaded.body.bot, copy = await copySkill();
  createdBots.push(bot.id);
  const path = `/api/skills/collection/${copy.slice("collection:".length)}`;
  const body = { description: "Edited method.", body: "Draft a better response." };
  const before = installationState([bot.id]);
  const act = challengedAct(await api("PUT", path, body));
  expect(act).toBe(installAct(path, body, copy, []));
  expect(installationState([bot.id])).toEqual(before);
  for (const auth of [chatCookie, phoneCookie, ""]) {
    expect((await api("PUT", path, body, undefined, auth)).status).toBe(403);
    expect(installationState([bot.id])).toEqual(before);
  }
  expect((await factorApi("PUT", path, body, phoneCookie, phoneId)).status).toBe(403);
  expect(installationState([bot.id])).toEqual(before);
  const switchPath = `/api/skills/${copy}/bots/${bot.id}`;
  expect((await api("PUT", switchPath, { on: true }, proof(challengedAct(await api("PUT", switchPath, { on: true }))))).status).toBe(200);
  const enabled = installationState([bot.id]);
  expect(challengedAct(await api("PUT", path, body))).toBe(installAct(path, body, copy, [bot.id]));
  expect(installationState([bot.id])).toEqual(enabled);
});

it("admits revert and accepts one content-bound approval through Cloud auth", async () => {
  const { bot, copy } = await copyAndBot();
  const onPath = `/api/skills/${copy}/bots/${bot.id}`;
  const onBody = { on: true };
  expect((await api("PUT", onPath, onBody, proof(challengedAct(await api("PUT", onPath, onBody))))).status).toBe(200);
  const path = `/api/skills/${copy}/revert`;
  const detail = await api("GET", "/api/skills/library:guide-one?view=library");
  const act = challengedAct(await api("POST", path, {}));
  expect(act).toBe(skillActDigest(routeActDigest("POST", path, {}), detail.body.scan.contentHash));
  expect((await api("GET", `/api/skills/${copy}?view=library`)).body.bots).toHaveLength(1);
  const header = proof(act);
  expect(await api("POST", path, {}, header)).toMatchObject({ status: 200, body: { reverted: true, movedBots: [{ id: bot.id }] } });
  expect((await api("GET", `/api/skills/${copy}`)).status).toBe(404);
  expect((await api("GET", "/api/skills/library:guide-one?view=library")).body.bots).toContainEqual(expect.objectContaining({ id: bot.id, name: bot.name }));
  expect((await api("POST", path, {}, header)).status).not.toBe(200);
});

it("saves a copy after the existing route approval without consuming a second incompatible proof", async () => {
  const { bot, copy } = await copyAndBot();
  expect((await api("PUT", `/api/skills/library:guide-one/bots/${bot.id}`, { on: true })).status).toBe(200);
  const path = `/api/skills/collection/${copy.slice("collection:".length)}`;
  const body = { description: "My edited method.", body: "Draft a better response." };
  const act = challengedAct(await api("PUT", path, body));
  // MAIN RULING 1115-SKAPI2
  const skillName = copy.slice("collection:".length);
  const description = body.description.replace(/\s+/g, " ").trim();
  const rewritten = ["---", `name: ${skillName}`, `description: ${JSON.stringify(description)}`, "---", body.body.replace(/^\s+/, "")].join("\n").replace(/\n*$/, "\n");
  const fileBytes = Buffer.from(rewritten, "utf8");
  const enabledBotIds = [bot.id].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const preimage = Buffer.concat([
    Buffer.from("skill-install-v1\n", "utf8"),
    Buffer.from(`file SKILL.md\n${fileBytes.length}\n`, "utf8"),
    fileBytes,
    Buffer.from("\n", "utf8"),
    Buffer.from("bots\n", "utf8"),
    ...enabledBotIds.map((id) => Buffer.from(`${id}\n`, "utf8")),
  ]);
  const installDigest = createHash("sha256").update(preimage).digest("hex");
  expect(act).toBe(skillActDigest(routeActDigest("PUT", path, body), installDigest));
  expect((await api("GET", `/api/skills/${copy}`)).body.updatedAt).toBeUndefined();
  const header = proof(act);
  expect((await api("PUT", path, { ...body, body: "Changed after approval." }, header)).status).toBe(403);
  expect(await api("PUT", path, body, header)).toMatchObject({ status: 200, body: { failed: [], needsLook: [] } });
  expect((await api("GET", `/api/skills/${copy}?view=library`)).body.bots).toContainEqual(expect.objectContaining({ id: bot.id, name: bot.name }));
  expect((await api("GET", "/api/skills/library:guide-one?view=library")).body.bots).not.toContainEqual(expect.objectContaining({ id: bot.id, name: bot.name }));
  expect((await api("PUT", path, body, header)).status).toBe(403);
});
