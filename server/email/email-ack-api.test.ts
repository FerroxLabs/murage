// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Private-port fixture owner: email-ack. Desktop persistence consumer owner: email-ack.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

// An isolated desktop parent with an encrypted, fsynced credential document.
// The acknowledgement is made by the production shell read-back function and
// delivered over the real utility-parent callback, never directly to a store.
const instrumentationSource = `
const fs = await import('node:fs');
const path = await import('node:path');
const crypto = await import('node:crypto');
const { EventEmitter } = await import('node:events');
const { registerHooks } = await import('node:module');
const email = await import(new URL('./electron/email-secrets.mjs', 'file://' + process.cwd() + '/'));
const root = process.env.MURAGE_DATA_DIR;
const disk = path.join(root, 'fixture-credentials.enc');
const observations = path.join(root, 'email-ack-observations.json');
const keyFile = path.join(root, 'fixture-encryption-key');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), {mode:0o600});
const key = fs.readFileSync(keyFile);
function decrypt(bytes) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
}
const port = new EventEmitter();
port.postMessage = message => {
  if (message.type === 'murage:desktop-secret') fs.writeFileSync(path.join(root, 'fixture-surface'), message.secret, {mode:0o600});
  if (!email.isEmailSecretsSave(message)) return;
  const doc = email.withEmailSecrets({}, message.doc);
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(doc)), cipher.final()]);
  const fd = fs.openSync(disk, 'w', 0o600);
  try { fs.writeFileSync(fd, Buffer.concat([nonce, cipher.getAuthTag(), encrypted])); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(root, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  void email.ackFromDisk({readFile: () => fs.readFileSync(disk), decrypt}, message).then(ack => {
    const ids = Object.values(message.doc.bots).map(value => value.keyId);
    const before = ids.map(id => globalThis.emailAckSecrets.isDurable(id));
    if (fs.existsSync(path.join(root, 'hold-email-ack'))) {
      fs.writeFileSync(path.join(root, 'old-email-ack.json'), JSON.stringify(ack));
    } else port.emit('message', {data: ack});
    const after = ids.map(id => globalThis.emailAckSecrets.isDurable(id));
    fs.writeFileSync(observations, JSON.stringify({before, after, readBack: ack.keyIds, epochType: typeof ack.epoch}));
  });
};
process.parentPort = port;
registerHooks({load(url, context, next) {
  const loaded = next(url, context);
  if (!url.endsWith('/server/index.ts')) return loaded;
  const anchor = 'for (const message of earlyEmailShellMessages.splice(0)) emailShellSink(message);';
  if (!String(loaded.source).includes(anchor)) throw new Error('Email observation anchor missing');
  return {...loaded, source: String(loaded.source).replace(anchor, anchor + '\\nglobalThis.emailAckSecrets = emailRuntime.secrets;')};
}});
const configFile = path.join(root, 'config.json'), config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
config.flux = {...config.flux, apiKey: config.flux?.apiKey ?? ['sk', 'flux', crypto.randomUUID()].join('-')};
fs.writeFileSync(configFile, JSON.stringify(config));
process.env.MURAGE_EMAIL_SECRETS = fs.existsSync(disk) ? email.emailSecretsEnv(JSON.parse(decrypt(fs.readFileSync(disk)))) : JSON.stringify({owner:{token:'fixture-owner-value',keyId:'key_owner'}});
const original = globalThis.fetch;
const inboxesFile = path.join(root, 'fixture-inboxes.json');
const inboxes = fs.existsSync(inboxesFile) ? JSON.parse(fs.readFileSync(inboxesFile, 'utf8')) : [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.protocol !== 'https:') return original(input, init);
  const method = String(init?.method ?? 'GET').toUpperCase(), p = url.pathname;
  if (p === '/v1/email/capabilities') return Response.json({enabled:true, available:true, account_state:'active', limits:{max_inboxes:5}});
  if (method === 'POST' && p === '/api/desktop/bot-keys') return Response.json({key:'fixture-bot-value',key_id:'key_' + JSON.parse(init.body).bot_id}, {status:201});
  if (method === 'POST' && p === '/v1/email/inboxes') {
    const botId = JSON.parse(init.body).bot_id;
    const inbox = inboxes.find(value => value.bot_id === botId) ?? {id:'ibx_' + botId, bot_id:botId, address:'fixture@example.test', state:'active', send_policy:'auto'};
    if (!inboxes.includes(inbox)) inboxes.push(inbox);
    fs.writeFileSync(inboxesFile, JSON.stringify(inboxes));
    return Response.json(inbox, {status:201});
  }
  if (method === 'GET' && p === '/v1/email/inboxes') return Response.json({data:inboxes});
  const inbox = inboxes.find(value => p === '/v1/email/inboxes/' + value.id);
  if (method === 'GET' && inbox) return Response.json(inbox);
  if (method === 'POST' && inboxes.some(value => p === '/v1/email/inboxes/' + value.id + '/recipients')) return Response.json(JSON.parse(init.body), {status:201});
  throw new Error('Unscripted external fixture request');
};
`;

let fixture: VerificationServer, headers: Record<string, string>;
const serverLogs = new Set<string>();
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(new URL(path, fixture.info.url), { method, headers: { ...headers, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as any };
}
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": readFileSync(join(fixture.info.dataDir, "fixture-surface"), "utf8") };
}, 120000);
afterAll(async () => {
  if (!fixture) return;
  serverLogs.add(fixture.info.logPath);
  await fixture.close();
  for (const logPath of serverLogs) console.info("email-ack fixture log", JSON.stringify({ logPath, text: readFileSync(logPath, "utf8") }));
});

it("a desktop save becomes durable through the parent chain, setup reaches an inbox, and trusted-add succeeds", async () => {
  expect((await call("GET", "/api/email/status?refresh=1")).status).toBe(200);
  const instances = (await call("GET", "/api/instances")).body.instances;
  const model = instances.find((entry: any) => entry.instanceId === "verification").models.options[0].id;
  const made = await call("POST", "/api/bots", { name: "Mail fixture", modelSelection: { instanceId: "verification", model } });
  expect(made.status).toBeLessThan(300);
  const id = made.body.bot.id;
  const setup = await call("POST", `/api/email/bots/${id}/setup`, { username: "fixture", displayName: "Fixture" });
  expect(setup.status).toBe(200);
  expect(setup.body).toMatchObject({ state: "active", address: "fixture@example.test" });
  const observed = JSON.parse(readFileSync(join(fixture.info.dataDir, "email-ack-observations.json"), "utf8"));
  expect(observed).toMatchObject({ before: [false], after: [true], epochType: "string" });
  expect(observed.readBack).toContain(`key_${id}`);
  const trusted = await call("POST", `/api/email/bots/${id}/trusted-add`, { entry: "friend@example.test" });
  expect(trusted.status).toBe(200);
  console.info("email-ack workflow proof", JSON.stringify({ fixture: fixture.info, observed, state: setup.body.state, address: setup.body.address, trustedAdd: trusted.status }));
}, 60000);

it("restarts after a durable write whose acknowledgement was withheld, then finishes the pending setup", async () => {
  const instances = (await call("GET", "/api/instances")).body.instances;
  const model = instances.find((entry: any) => entry.instanceId === "verification").models.options[0].id;
  const made = await call("POST", "/api/bots", { name: "Restart fixture", modelSelection: { instanceId: "verification", model } });
  expect(made.status).toBeLessThan(300);
  const id = made.body.bot.id, held = join(fixture.info.dataDir, "hold-email-ack");
  writeFileSync(held, "");
  // Attach the rejection before stopping the exact fixture child closes HTTP.
  const pending = call("POST", `/api/email/bots/${id}/setup`, { username: "fixture", displayName: "Fixture" }).catch(() => null);
  await expect.poll(() => {
    try { return JSON.parse(readFileSync(join(fixture.info.dataDir, "email-ack-observations.json"), "utf8")); } catch { return null; }
  }, { timeout: 10000 }).toMatchObject({ after: expect.arrayContaining([false]), readBack: expect.arrayContaining([`key_${id}`]) });
  serverLogs.add(fixture.info.logPath);
  await fixture.stop();
  await pending;
  unlinkSync(held);
  await fixture.restart();
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": readFileSync(join(fixture.info.dataDir, "fixture-surface"), "utf8") };
  await expect.poll(() => call("GET", `/api/email/bots/${id}`), { timeout: 20000 }).toMatchObject({ status: 200, body: { state: "active", address: "fixture@example.test" } });
  const setup = await call("GET", `/api/email/bots/${id}`);
  expect(setup.status).toBe(200);
  expect(setup.body).toMatchObject({ state: "active", address: "fixture@example.test" });
  expect((await call("POST", `/api/email/bots/${id}/trusted-add`, { entry: "friend@example.test" })).status).toBe(200);
  console.info("email-ack restart proof", JSON.stringify({ fixture: fixture.info, state: setup.body.state, address: setup.body.address }));
}, 120000);
