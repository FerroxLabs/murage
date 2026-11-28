// Rings witnesses (designs/RINGS-DESIGN.md B2, B3, K3 writer). Entry point: the update coordinator's check() /
// download() / install(), the functions behind the update:check / update:download / update:install IPC
// (electron/updater.mjs registerUpdaterIpc). The ring feed is the real one (real OpenPGP Ed25519 verification of the
// real manifest bytes, real cache and kill files on disk); only the network and electron-updater's provider are
// recorded fakes: the provider answers with the version that the feed it was pointed at names.
// On a build without the ring step the coordinator has no ringFeed, so it runs today's GitHub-latest path; the rows
// then fail at their offer / install assertions (that is the base RED, by behaviour).
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { verifyDetachedSignature } from "./update-signature.mjs";
import { updateNotificationsEnabled } from "./update-notifications.mjs";

const rings = await import("./updater-rings.mjs").catch(() => null);

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const packet = (tag, body) => Buffer.concat([Buffer.from([0xc0 | tag, 255]), u32(body.length), body]);
const mpi = (value) => {
  let b = Buffer.from(value);
  while (b.length && b[0] === 0) b = b.subarray(1);
  return Buffer.concat([u16(b.length ? (b.length - 1) * 8 + 32 - Math.clz32(b[0]) : 0), b]);
};
function armor(kind, bytes) {
  let crc = 0xb704ce;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x1864cfb; }
  }
  const check = Buffer.from([(crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]).toString("base64");
  return `-----BEGIN PGP ${kind}-----\n\n${bytes.toString("base64").match(/.{1,64}/g).join("\n")}\n=${check}\n-----END PGP ${kind}-----\n`;
}
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const body = Buffer.concat([Buffer.from([4]), u32(1700000000), Buffer.from([22, 9]), Buffer.from("2b06010401da470f01", "hex"), mpi(Buffer.concat([Buffer.from([0x40]), raw]))]);
  const fingerprint = createHash("sha1").update(Buffer.concat([Buffer.from([0x99]), u16(body.length), body])).digest();
  return { privateKey, fingerprint, publicKey: armor("PUBLIC KEY BLOCK", packet(6, body)) };
}
function signed(data, key) {
  const subpackets = Buffer.concat([Buffer.from([22, 33, 4]), key.fingerprint, Buffer.from([5, 2]), u32(1700000001)]);
  const prefix = Buffer.concat([Buffer.from([4, 0, 22, 8]), u16(subpackets.length), subpackets]);
  const digest = createHash("sha256").update(data).update(prefix).update(Buffer.concat([Buffer.from([4, 255]), u32(prefix.length)])).digest();
  const sig = sign(null, digest, key.privateKey);
  return armor("SIGNATURE", packet(2, Buffer.concat([prefix, u16(0), digest.subarray(0, 2), mpi(sig.subarray(0, 32)), mpi(sig.subarray(32))])));
}
const publisher = keypair();
const attacker = keypair();

const RUNNING = "1.0.23";
const LATEST = "1.0.24"; // GitHub /releases/latest = ring all
const NOW = Date.parse("2026-11-28T12:00:00Z");
function manifest({ seq = 5, internal = "1.0.26", beta = "1.0.25", all = LATEST, kill = [], expiresAt = "2026-12-01T10:00:00Z" } = {}) {
  return Buffer.from(JSON.stringify({
    schema: 1, seq, issuedAt: "2026-11-28T10:00:00Z", expiresAt,
    rings: {
      internal: { version: internal, since: "2026-11-28T10:00:00Z" },
      beta: { version: beta, since: "2026-11-27T10:00:00Z", halted: false },
      all: { version: all, since: "2026-11-26T10:00:00Z", halted: false },
    },
    kill,
  }));
}

// The network: manifest + .asc on raw.githubusercontent, the github.com latest lookup.
function network(state) {
  return async (url) => {
    const text = String(url);
    if (text.startsWith("https://raw.githubusercontent.com/FerroxLabs/murage-releases/rings/rings/rings.json")) {
      if (state.gate) await state.gate;
      if (!state.manifest) return new Response("", { status: state.manifestStatus ?? 404 });
      const bytes = state.manifest;
      return new Response(text.endsWith(".asc") ? signed(bytes, state.signer ?? publisher) : bytes);
    }
    if (text === "https://github.com/FerroxLabs/murage-releases/releases/latest") {
      if (state.latestGate) await state.latestGate;
      if (state.latestDown) throw new Error("offline");
      return Response.json({ tag_name: `v${state.latest}` });
    }
    if (text === "https://api.github.com/repos/FerroxLabs/murage-releases/releases/latest") {
      if (state.apiDown) throw new Error("offline");
      return Response.json({ tag_name: `v${state.latest}`, draft: false, prerelease: false, assets: [{ name: "latest-linux.yml" }] });
    }
    throw new Error(`unexpected fetch ${text}`);
  };
}

// electron-updater stand-in: answers from the feed it was last pointed at.
function fakeUpdater(state, dir) {
  const updater = new EventEmitter();
  updater.feeds = [];
  updater.installs = 0;
  updater.logger = { info() {}, warn() {}, error() {} };
  let feed = { provider: "github" };
  let offered = null;
  updater.setFeedURL = (options) => { feed = options; updater.feeds.push(options); };
  updater.checkForUpdates = async () => {
    updater.emit("checking-for-update");
    const tag = feed.provider === "generic" ? /\/download\/v([^/]+)$/.exec(feed.url)[1] : state.latest;
    const version = state.feedNames?.[tag] ?? tag;
    if (version === RUNNING) { offered = null; updater.emit("update-not-available"); return { isUpdateAvailable: false }; }
    offered = version;
    updater.emit("update-available", { version });
    return { isUpdateAvailable: true, updateInfo: { version } };
  };
  updater.downloadUpdate = async () => {
    const version = state.nextDownload ?? offered;
    const file = join(dir, `Murage-${version}.AppImage`);
    await writeFile(file, "app");
    updater.emit("update-downloaded", { version });
    return [file];
  };
  updater.quitAndInstall = () => { updater.installs += 1; };
  return updater;
}

// The real IPC registration (electron/updater.mjs registerUpdaterIpc + updateChannelFile), lifted out of the module the way
// updater-staging.node-test.mjs lifts startUpdater (the module imports electron). Renderer calls arrive as invoke(channel).
const updaterSource = readFileSync(new URL("./updater.mjs", import.meta.url), "utf8");
const updaterFile = ts.createSourceFile("updater.mjs", updaterSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const updaterFunction = (name) => updaterFile.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
function registerIpc(dir, coordinator) {
  const handlers = new Map();
  const context = vm.createContext({
    updaterCoordinator: coordinator, publicState: () => ({}), join, app: { getPath: () => dir },
    readGetUpdatesEarly: rings?.readGetUpdatesEarly, writeGetUpdatesEarly: rings?.writeGetUpdatesEarly,
  });
  for (const name of ["updateChannelFile", "registerUpdaterIpc"]) {
    const node = updaterFunction(name);
    if (node) vm.runInContext(node.getText(updaterFile).replace(/^export\s+/, ""), context);
  }
  context.registerUpdaterIpc({ handle: (channel, handler) => handlers.set(channel, handler) });
  // Electron rejects an invoke on a channel nobody handles; the Settings switch then saves nothing.
  return { invoke: async (channel, ...args) => { const handler = handlers.get(channel); if (!handler) throw new Error(`No handler registered for '${channel}'`); return handler({}, ...args); } };
}

// macOS copy this person cannot replace (electron/mac-install-guard.mjs): every install goes to the dmg offer instead.
function macFallback() {
  return { blocked: () => "not-replaceable", offer: (version) => ({ status: "installer-offer", version }), events: new EventEmitter(), persist() {}, recover() {} };
}

// The REAL vendored electron-updater (electron/vendor/electron-updater.cjs, AppImageUpdater on this Linux runner) with
// the production app-update.yml (github provider, FerroxLabs/murage-releases). Only its HTTP executor is replaced by an
// in-process fixture origin serving github.com: the releases Atom feed, /releases/latest, and each tag's latest-linux.yml
// (the stable feed and every ring tag's feed). Its own GitHub and generic providers resolve the tag, the feed URL and the
// version, as in the packaged app.
const vendor = (() => {
  const load = Module._load;
  Module._load = (request, ...rest) => (request === "electron" ? { app: {}, autoUpdater: new EventEmitter() } : load(request, ...rest));
  try { return createRequire(import.meta.url)("./vendor/electron-updater.cjs"); } finally { Module._load = load; }
})();
async function vendoredUpdater(state, dir) {
  await writeFile(join(dir, "app-update.yml"), "provider: github\nowner: FerroxLabs\nrepo: murage-releases\n");
  const app = {
    whenReady: async () => {}, version: RUNNING, name: "Murage", isPackaged: true, appUpdateConfigPath: join(dir, "app-update.yml"),
    userDataPath: dir, baseCachePath: dir, quit() {}, relaunch() {}, onQuit() {},
  };
  const updater = new vendor.AppImageUpdater(null, app);
  updater.forceDevUpdateConfig = true; // AppImageUpdater is otherwise inactive outside an AppImage (no $APPIMAGE here)
  updater.autoDownload = false;
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const base = "https://github.com/FerroxLabs/murage-releases/releases";
  const serve = (url) => {
    const at = new URL(url); at.search = "";
    const href = at.href;
    if (href === `${base}.atom`) {
      return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:github.com,2008:Repository/1/v${state.latest}</id><updated>2026-11-26T10:00:00Z</updated><link rel="alternate" type="text/html" href="/FerroxLabs/murage-releases/releases/tag/v${state.latest}"/><title>v${state.latest}</title><content>No content.</content></entry></feed>`;
    }
    if (href === `${base}/latest`) return JSON.stringify({ tag_name: `v${state.latest}` });
    const feed = new RegExp(`^${base}/download/v([^/]+)/latest-linux\\.yml$`).exec(href);
    if (feed) {
      const version = state.feedNames?.[feed[1]] ?? feed[1];
      return `version: ${version}\nfiles:\n  - url: Murage-${version}.AppImage\n    sha512: ${"A".repeat(86)}==\n    size: 3\npath: Murage-${version}.AppImage\nsha512: ${"A".repeat(86)}==\nreleaseDate: '2026-11-26T10:00:00.000Z'\n`;
    }
    throw Object.assign(new Error(`404 ${href}`), { statusCode: 404 });
  };
  updater.requests = [];
  updater.httpExecutor = {
    request: async (options) => {
      const url = `${options.protocol ?? "https:"}//${options.hostname}${options.port ? `:${options.port}` : ""}${options.path}`;
      updater.requests.push(url);
      return serve(url);
    },
  };
  updater.feeds = [];
  const setFeedURL = updater.setFeedURL.bind(updater);
  updater.setFeedURL = (options) => { updater.feeds.push(options); return setFeedURL(options); };
  updater.installs = 0;
  updater.quitAndInstall = () => { updater.installs += 1; };
  return updater;
}

async function setup(t, { member = "none", early = false, ...network_ } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "murage-rings-")));
  t.after(() => safeWipeSync(dir));
  const state = { latest: LATEST, manifest: manifest(), ...network_ };
  if (member === "internal") await writeFile(join(dir, "update-ring.json"), JSON.stringify({ ring: "internal" }));
  if (early) await writeFile(join(dir, "update-channel.json"), JSON.stringify({ early: true }));
  if (network_.cacheSeed) await writeFile(join(dir, "rings-cache.json"), JSON.stringify({ bytes: network_.cacheSeed.toString("base64"), signature: signed(network_.cacheSeed, publisher) }));
  const updater = network_.vendored ? await vendoredUpdater(state, dir) : fakeUpdater(state, dir);
  const states = [];
  const fetchImpl = network(state);
  const ringFeed = rings?.createRingFeed(updater, {
    currentVersion: RUNNING, publicKey: publisher.publicKey, verify: verifyDetachedSignature,
    cacheFile: join(dir, "rings-cache.json"), killFile: join(dir, "kill-switches.json"), floorSeq: 3,
    membership: rings.createRingMembership({ ringFile: join(dir, "update-ring.json"), channelFile: join(dir, "update-channel.json"), readText: (f) => readFileSync(f, "utf8") }),
    fetchImpl, now: () => NOW, ...(network_.writeText ? { writeText: network_.writeText } : {}), ...(network_.readText ? { readText: network_.readText } : {}),
  });
  const coordinator = createUpdaterCoordinator(updater, (patch) => states.push(patch), {
    ...(ringFeed ? { ringFeed } : {}), ...(network_.fallback ? { installerFallback: macFallback() } : {}), handOffInstall: network_.handOff ? async (files) => { state.handedOff = (state.handedOff ?? 0) + 1; state.handedOffFiles = files; return {}; } : null,
  });
  const offered = () => states.filter((s) => s.status === "available").map((s) => s.version);
  const dmgOffers = () => states.filter((s) => s.status === "installer-offer").map((s) => s.version);
  const installed = () => updater.installs + (state.handedOff ?? 0);
  const ipc = registerIpc(dir, coordinator);
  return { dir, state, updater, states, coordinator, ipc, offered, installed, dmgOffers, ringFeed };
}

// ---- B2: which version a check offers (R4-R7, R6 binding) ----
test("B2(a) an internal-marked install is offered the version only ring internal names", async (t) => {
  const f = await setup(t, { vendored: true, member: "internal" });
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), ["1.0.26"]);
  assert.equal(f.updater.feeds.at(-1).url, "https://github.com/FerroxLabs/murage-releases/releases/download/v1.0.26");
  // the vendored generic provider itself read that tag's feed
  assert.ok(f.updater.requests.some((url) => url.startsWith("https://github.com/FerroxLabs/murage-releases/releases/download/v1.0.26/latest-linux.yml")));
});

test("B2(b) no marker, early off: offered ring all only, never the beta or internal version", async (t) => {
  const f = await setup(t, { vendored: true, vendored: true });
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), [LATEST]);
});

test("B2(b2) ring all pinned back to the running version while GitHub latest still names the bad one: nothing offered", async (t) => {
  const f = await setup(t, { vendored: true, manifest: manifest({ all: RUNNING, beta: RUNNING, internal: RUNNING }) });
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), []);
});

test("B2(c) 'Get updates early' on: offered the beta version, which is not GitHub latest", async (t) => {
  const f = await setup(t, { vendored: true, early: true });
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), ["1.0.25"]);
});

test("B2(d) the unsigned feed under the allowed tag names another version: not offered and not downloadable", async (t) => {
  const f = await setup(t, { vendored: true, early: true, feedNames: { "1.0.25": "1.0.27" } });
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), []);
  await f.ipc.invoke("update:download");
  assert.equal(f.states.some((s) => s.status === "downloaded"), false);
});

const KILL = [{ id: "memory.recall.inject", versions: ">=1.0.23 <1.0.24", code: "kill-safety" }];
const killFile = (f) => (existsSync(join(f.dir, "kill-switches.json")) ? JSON.parse(readFileSync(join(f.dir, "kill-switches.json"), "utf8")) : null);

test("B2(e) a manifest signed by another key is ignored: no early version from it, and the cached kill holds", async (t) => {
  const f = await setup(t, { vendored: true, early: true, manifest: manifest({ seq: 6, beta: LATEST, kill: KILL }) });
  await f.ipc.invoke("update:check");
  f.state.manifest = manifest({ seq: 9 }); // names beta 1.0.25, no kill
  f.state.signer = attacker;
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), [LATEST, LATEST]);
  assert.deepEqual(killFile(f), { seq: 6, kills: ["memory.recall.inject"] });
});

test("B2(f) a replayed older manifest never outranks the cached one (R2): no early version from it, the kill holds", async (t) => {
  const f = await setup(t, { vendored: true, early: true, manifest: manifest({ seq: 6, beta: LATEST, kill: KILL }) });
  await f.ipc.invoke("update:check");
  f.state.manifest = manifest({ seq: 5 }); // older seq, names beta 1.0.25, no kill
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), [LATEST, LATEST]);
  assert.deepEqual(killFile(f), { seq: 6, kills: ["memory.recall.inject"] });
});

test("B2(g) a manifest older than this build's floor is refused even on a fresh profile (R2)", async (t) => {
  const f = await setup(t, { vendored: true, early: true, manifest: manifest({ seq: 2 }) }); // floorSeq is 3
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), [LATEST]);
  assert.equal(f.updater.feeds.some((feed) => feed.provider === "generic"), false);
});

test("B2(h) an expired manifest drops ring targets (ring all) but keeps its kill (R3)", async (t) => {
  const f = await setup(t, { vendored: true, early: true, manifest: manifest({ kill: KILL, expiresAt: "2026-11-28T11:00:00Z" }) });
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), [LATEST]);
  assert.deepEqual(killFile(f), { seq: 5, kills: ["memory.recall.inject"] });
});

test("B3(vi) expired accepted manifest: install admitted through the github.com latest lookup", async (t) => {
  const f = await setup(t, { manifest: manifest({ expiresAt: "2026-11-28T11:00:00Z" }) });
  await f.ipc.invoke("update:check");
  await f.ipc.invoke("update:download");
  await f.ipc.invoke("update:install");
  assert.equal(f.installed(), 1);
});

// ---- B3: install-time admission (R8) on the restart and hand-off paths ----
for (const path of ["restart", "handoff"]) {
  const handOff = path === "handoff";
  test(`B3(i) ${path}: ring halted (pinned back) after the download was staged -> nothing installs, download discarded`, async (t) => {
    const f = await setup(t, { member: "internal", handOff });
    await f.ipc.invoke("update:check");
    await f.ipc.invoke("update:download");
    f.state.manifest = manifest({ seq: 6, internal: LATEST });
    await f.ipc.invoke("update:install");
    assert.equal(f.installed(), 0);
    assert.equal(existsSync(join(f.dir, "Murage-1.0.26.AppImage")), false);
    assert.equal(f.states.at(-1).message, "This update was paused. You'll get the next one automatically.");
  });

  test(`B3(ii) ${path}: admission refetch fails -> nothing installs, download stays staged`, async (t) => {
    const f = await setup(t, { member: "internal", handOff });
    await f.ipc.invoke("update:check");
    await f.ipc.invoke("update:download");
    f.state.manifest = null;
    f.state.manifestStatus = 503;
    await f.ipc.invoke("update:install");
    assert.equal(f.installed(), 0);
    assert.equal(existsSync(join(f.dir, "Murage-1.0.26.AppImage")), true);
    assert.equal(f.states.at(-1).message, "Couldn't confirm this update. Murage will try again.");
  });

  test(`B3(v) ${path}: the halt was seen at a check, then the install refetch is served the stale pre-halt manifest -> no install`, async (t) => {
    const f = await setup(t, { member: "internal", handOff });
    await f.ipc.invoke("update:check");
    await f.ipc.invoke("update:download");
    f.state.manifest = manifest({ seq: 6, internal: LATEST });
    await f.ipc.invoke("update:check"); // halt accepted (seq 6)
    f.state.manifest = manifest({ seq: 5 }); // CDN serves the older copy
    await f.ipc.invoke("update:install");
    assert.equal(f.installed(), 0);
  });

  test(`B3(iii) ${path}: legacy path (no manifest ever), MAIN pins latest back -> no install`, async (t) => {
    const f = await setup(t, { handOff, manifest: null });
    await f.ipc.invoke("update:check");
    await f.ipc.invoke("update:download");
    f.state.latest = RUNNING; // pin-latest
    await f.ipc.invoke("update:install");
    assert.equal(f.installed(), 0);
  });

  test(`B3(iv) ${path}: legacy path, latest unchanged -> installs`, async (t) => {
    const f = await setup(t, { handOff, manifest: null });
    await f.ipc.invoke("update:check");
    await f.ipc.invoke("update:download");
    await f.ipc.invoke("update:install");
    assert.equal(f.installed(), 1);
  });

  test(`B3(ok) ${path}: the manifest still names the staged version -> installs`, async (t) => {
    const f = await setup(t, { member: "internal", handOff });
    await f.ipc.invoke("update:check");
    await f.ipc.invoke("update:download");
    await f.ipc.invoke("update:install");
    assert.equal(f.installed(), 1);
  });
}

// ---- K3 writer: the verified, version-filtered kill set reaches <userData>/kill-switches.json ----
test("K3 a signed kill for this version is written to the kill file at the check; unknown ids and other versions are not", async (t) => {
  const kill = [
    { id: "memory.recall.inject", versions: ">=1.0.23 <1.0.24", code: "kill-safety" },
    { id: "memory.capture", versions: ">=1.0.25", code: "kill-data" },
    { id: "memory.future", versions: ">=1.0.0", code: "kill-perf" },
  ];
  const f = await setup(t, { manifest: manifest({ kill }) });
  await f.ipc.invoke("update:check");
  const file = join(f.dir, "kill-switches.json");
  assert.equal(existsSync(file), true, "kill file written");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { seq: 5, kills: ["memory.recall.inject"] });
});

// ---- B5: the Settings switch (preload setUpdatesEarly -> update:set-early IPC) changes the next check's ring, and the
// saved choice is what update:get-early reads back after a restart ----
test("B5 'Get updates early' switched on in Settings moves the next check to the beta version; off again keeps the build", async (t) => {
  const f = await setup(t, { vendored: true });
  await f.ipc.invoke("update:check");
  await f.ipc.invoke("update:set-early", true).catch(() => undefined); // the switch; a refused invoke saves nothing
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), [LATEST, "1.0.25"]);
  assert.equal(await registerIpc(f.dir, f.coordinator).invoke("update:get-early"), true); // a fresh process reads it back
  await f.ipc.invoke("update:set-early", false);
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), [LATEST, "1.0.25", LATEST]);
});

// ---- B3 legacy host rows: github.com unreachable falls to the api.github.com lookup; both down = nothing installs ----
test("B3(vii) legacy path, github.com latest unreachable: admitted through api.github.com when it still names the version", async (t) => {
  const f = await setup(t, { manifest: null });
  await f.ipc.invoke("update:check");
  await f.ipc.invoke("update:download");
  f.state.latestDown = true;
  await f.ipc.invoke("update:install");
  assert.equal(f.installed(), 1);
});

test("B3(viii) legacy path, both latest lookups unreachable: nothing installs, download kept", async (t) => {
  const f = await setup(t, { manifest: null });
  await f.ipc.invoke("update:check");
  await f.ipc.invoke("update:download");
  f.state.latestDown = true;
  f.state.apiDown = true;
  await f.ipc.invoke("update:install");
  assert.equal(f.installed(), 0);
  assert.equal(existsSync(join(f.dir, `Murage-${LATEST}.AppImage`)), true);
});

// ---- B3(ix) overlap: a download started while admission is in flight never swaps the files that launch ----
test("B3(ix) handoff: a second download during install admission cannot replace the admitted files", async (t) => {
  const f = await setup(t, { early: true, handOff: true });
  await f.ipc.invoke("update:check"); // offered beta 1.0.25
  await f.ipc.invoke("update:download");
  const admitted = join(f.dir, "Murage-1.0.25.AppImage");
  let open;
  f.state.gate = new Promise((resolve) => { open = resolve; });
  const install = f.ipc.invoke("update:install"); // admission waits on the gated manifest refetch
  f.state.nextDownload = "1.0.27"; // the provider would now hand over another version's files
  const second = f.ipc.invoke("update:download");
  open();
  await Promise.all([install, second]);
  assert.deepEqual(f.state.handedOffFiles, [admitted]);
  assert.equal(existsSync(join(f.dir, "Murage-1.0.27.AppImage")), false);
});

// ---- B3 backup continuation (resumeInstall, electron/preupgrade-continuation.mjs:24) ----
async function resumeSetup(t, network_ = {}) {
  const f = await setup(t, { early: true, ...network_ });
  const bytes = "fixture only";
  const file = join(f.dir, "Murage-1.0.25.AppImage");
  await writeFile(file, bytes);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const infoFor = (version) => ({ version, files: [{ url: `Murage-${version}.AppImage`, sha512 }] });
  const { captureUpdateCandidate } = await import("./updater-candidate.mjs");
  f.updater.downloadedUpdateHelper = { cacheDir: f.dir, file, versionInfo: infoFor("1.0.25"), fileInfo: { info: infoFor("1.0.25").files[0] } };
  const candidate = await captureUpdateCandidate(f.updater);
  // A fresh process: the provider answers from the feed it points at, as in check().
  const check = f.updater.checkForUpdates;
  f.updater.checkForUpdates = async () => { const r = await check(); return r.isUpdateAvailable ? { ...r, updateInfo: infoFor(r.updateInfo.version) } : r; };
  f.updater.downloadUpdate = async () => [file];
  const calls = { hooks: 0 };
  const resume = () => f.coordinator.resumeInstall(candidate, { beforeInstall: () => { calls.hooks += 1; return { status: "continue" }; } }).catch((error) => error);
  return { ...f, calls, resume };
}

test("B3(x) resumeInstall: a beta candidate is rechecked on its ring tag and installs", async (t) => {
  const f = await resumeSetup(t);
  await f.resume();
  assert.equal(f.updater.installs, 1);
});

test("B3(xi) resumeInstall: ring paused since staging (GitHub latest still names it) -> refused before the backup hook closes anything", async (t) => {
  const f = await resumeSetup(t, { latest: "1.0.25", manifest: manifest({ seq: 6, beta: LATEST }) });
  await f.resume();
  assert.equal(f.calls.hooks, 0);
  assert.equal(f.updater.installs, 0);
});

test("B3(xii) resumeInstall, legacy path: manifest and both latest lookups unreachable -> refused before the backup hook", async (t) => {
  const f = await resumeSetup(t, { latest: "1.0.25", manifest: null, latestDown: true, apiDown: true });
  await f.resume();
  assert.equal(f.calls.hooks, 0);
  assert.equal(f.updater.installs, 0);
});

// ---- B3(xiii) a halt accepted by a check while a legacy admission waits on GitHub latest still stops the install ----
test("B3(xiii) restart: halt accepted by a manual check during the legacy latest lookup -> no install", async (t) => {
  const f = await setup(t, { manifest: null });
  await f.ipc.invoke("update:check");
  await f.ipc.invoke("update:download"); // staged GitHub latest 1.0.24 through the legacy path
  let open;
  f.state.latestGate = new Promise((resolve) => { open = resolve; });
  const install = f.ipc.invoke("update:install"); // admission: no manifest, waits on github.com latest (still 1.0.24)
  await new Promise((resolve) => setImmediate(resolve));
  f.state.manifest = manifest({ seq: 6, all: RUNNING, beta: RUNNING, internal: RUNNING }); // MAIN halts all
  const halted = f.ipc.invoke("update:check");
  await halted;
  open();
  await install;
  assert.equal(f.installed(), 0);
});

// ---- B3 dmg offer (Fable/Astra 6cdb66fe4b High, updater-coordinator resumeInstall + showInstallerOffer): a Mac copy that
// cannot be replaced is offered the installer instead of an install; that offer passes the same R8 admission ----
const PAUSED = { latest: "1.0.25", manifest: manifest({ seq: 6, beta: LATEST }) }; // beta pinned back to 1.0.24 after 1.0.25 staged

test("B3(xiv) resumeInstall on a Mac copy that cannot be replaced: ring paused since staging -> no installer offered", async (t) => {
  const f = await resumeSetup(t, { ...PAUSED, fallback: true });
  const error = await f.resume();
  assert.deepEqual(f.dmgOffers(), []);
  assert.equal(f.calls.hooks, 0);
  assert.equal(error?.message, "This update was paused. You'll get the next one automatically.");
});

test("B3(xiv-ok) resumeInstall on a Mac copy that cannot be replaced: ring still names the candidate -> installer offered", async (t) => {
  const f = await resumeSetup(t, { fallback: true });
  await f.resume();
  assert.deepEqual(f.dmgOffers(), ["1.0.25"]);
});

test("B3(xv) relaunch shows the previous run's installer offer: its version was paused meanwhile -> not shown, offer spent", async (t) => {
  const f = await setup(t, { early: true, ...PAUSED, fallback: true });
  const spent = await f.coordinator.showInstallerOffer("1.0.25", "previous-run");
  assert.deepEqual(f.dmgOffers(), []);
  assert.equal(spent, true);
});

test("B3(xvi) relaunch shows the previous run's installer offer: manifest and both latest lookups unreachable -> not shown, offer kept", async (t) => {
  const f = await setup(t, { manifest: null, latestDown: true, apiDown: true, fallback: true });
  const spent = await f.coordinator.showInstallerOffer(LATEST, "previous-run");
  assert.deepEqual(f.dmgOffers(), []);
  assert.equal(spent, false);
});

test("B3(xv-ok) relaunch shows the previous run's installer offer: the ring still names it -> shown", async (t) => {
  const f = await setup(t, { early: true, fallback: true });
  const spent = await f.coordinator.showInstallerOffer("1.0.25", "previous-run");
  assert.deepEqual(f.dmgOffers(), ["1.0.25"]);
  assert.equal(spent, true);
});

// ---- B3 relaunch through the real startUpdater (electron/updater.mjs publishOffer, Opus r3 self-review High): the
// previous run's dmg offer is acknowledged (deleted) only when it was shown or its version is paused; an offer whose
// admission could not be confirmed stays pending for the next launch ----
async function relaunch(t, network_) {
  const f = await setup(t, { fallback: true, ...network_ });
  const pending = { version: network_.pendingVersion ?? "1.0.25", reason: "install-stalled" };
  const acks = [];
  const fallback = { ...macFallback(), peekPendingOffer: () => pending, acknowledgePendingOffer: (offer) => { acks.push(offer); } };
  let shown = null;
  const states = [];
  const context = vm.createContext({
    queueMicrotask, updateNotificationsEnabled, updaterCoordinator: null, launchPause: null, checksScheduled: false, autoUpdater: null,
    app: { isPackaged: true }, process: { platform: "darwin", env: {} }, require: () => ({ autoUpdater: f.updater }), updaterLogger: () => f.updater.logger,
    linuxPackageType: () => null, HAND_OFF_TYPES: new Set(), createUpdateDownloadVerifier: () => null,
    createGithubFallbackFeed: () => ({ activate: async () => false, reset() {} }), createDesktopRingFeed: () => f.ringFeed ?? null,
    installWindowsUpdateVerifier: () => false, runningVersion: () => RUNNING, setState: (patch) => states.push(patch),
    // records what showInstallerOffer returned so the row can wait for it; the coordinator itself is the real one
    createUpdaterCoordinator: (...args) => { const real = createUpdaterCoordinator(...args); return { ...real, showInstallerOffer: (...a) => (shown = real.showInstallerOffer(...a)) }; },
    setTimeout: () => ({ unref() {} }), setInterval: () => ({ unref() {} }),
  });
  vm.runInContext(updaterFunction("startUpdater").getText(updaterFile).replace(/^export\s+/, ""), context);
  context.startUpdater({ scheduleChecks: true, installerFallback: fallback });
  await shown;
  await new Promise((resolve) => setImmediate(resolve));
  return { acks, dmgOffers: () => states.filter((s) => s.status === "installer-offer").map((s) => s.version) };
}

test("B3(xvii) relaunch through startUpdater: admission unconfirmed (manifest and both latest lookups unreachable) -> not shown, offer not acknowledged", async (t) => {
  const r = await relaunch(t, { manifest: null, latestDown: true, apiDown: true, pendingVersion: LATEST });
  assert.deepEqual(r.dmgOffers(), []);
  assert.equal(r.acks.length, 0);
});

test("B3(xvii-ok) relaunch through startUpdater: the ring still names the offered version -> shown and acknowledged once", async (t) => {
  const r = await relaunch(t, { early: true });
  assert.deepEqual(r.dmgOffers(), ["1.0.25"]);
  assert.equal(r.acks.length, 1);
});

// ---- R2 persisted halt (Astra 47f55321c4 High): a check and an install admission accept manifests concurrently; the
// lower-seq cache write lands last on disk. After a restart, a stale CDN copy of the pre-halt manifest must still lose
// to the halt this profile already accepted. The only injection is timing: the real atomic writer, held until the halt
// has been accepted ----
test("B2(i) halt accepted by a check while an admission's older cache write is still on its way: after a restart the stale pre-halt manifest offers nothing halted", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const writeText = async (file, text) => {
    if (file.endsWith("rings-cache.json") && JSON.parse(Buffer.from(JSON.parse(text).bytes, "base64").toString()).seq === 5) await held;
    return rings.writeAtomic(file, text);
  };
  const f = await setup(t, { early: true, manifest: manifest({ seq: 4 }), writeText });
  await f.ipc.invoke("update:check");
  await f.ipc.invoke("update:download"); // 1.0.25 staged from beta (seq 4)
  f.state.manifest = manifest({ seq: 5 }); // a resign: same content, seq 5
  const install = f.ipc.invoke("update:install"); // admission accepts seq 5; its cache write is held
  await new Promise((resolve) => setImmediate(resolve));
  f.state.manifest = manifest({ seq: 6, beta: LATEST }); // MAIN halts beta back to 1.0.24
  const halted = f.ipc.invoke("update:check");
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all([install, halted]);
  // restart on the same profile; the CDN still serves the pre-halt seq 5
  // (a build without the ring module restarts with no ring feed, as setup() does)
  const again = createUpdaterCoordinator(f.updater, (patch) => f.states.push(patch), rings ? {
    ringFeed: rings.createRingFeed(f.updater, {
      currentVersion: RUNNING, publicKey: publisher.publicKey, verify: verifyDetachedSignature,
      cacheFile: join(f.dir, "rings-cache.json"), killFile: join(f.dir, "kill-switches.json"), floorSeq: 3,
      membership: rings.createRingMembership({ ringFile: join(f.dir, "update-ring.json"), channelFile: join(f.dir, "update-channel.json"), readText: (file) => readFileSync(file, "utf8") }),
      fetchImpl: network(f.state), now: () => NOW,
    }),
  } : {});
  f.state.manifest = manifest({ seq: 5 });
  f.states.length = 0;
  await registerIpc(f.dir, again).invoke("update:check");
  assert.deepEqual(f.offered(), [LATEST]);
});

// ---- R2 first cache read (Astra bfa2314574 High): a fresh process starts a check whose read of the stored (pre-halt)
// manifest is still on its way when an admission (the previous run's dmg offer) accepts the halt from the network; the
// stored copy must not replace the halt, so the check, served the stale pre-halt manifest, offers nothing halted. The
// only injection is timing: the real file read, held until the admission has finished ----
test("B2(j) halt accepted by an admission while a check's first cache read is still on its way: the stored pre-halt manifest never replaces it", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  // the first read returns what was on disk when it started (the stored seq 5), however late it lands
  const readText = async (file) => { const text = readFileSync(file, "utf8"); if ((reads += 1) === 1) await held; return text; };
  const f = await setup(t, { early: true, fallback: true, cacheSeed: manifest({ seq: 5 }), manifest: manifest({ seq: 6, beta: LATEST }), readText });
  const check = f.ipc.invoke("update:check"); // first read of the stored seq 5 is held
  await new Promise((resolve) => setImmediate(resolve));
  const offer = f.coordinator.showInstallerOffer("1.0.25", "previous-run"); // admission: network serves the halt (seq 6)
  // An admission that did not wait for the stored copy has accepted the halt by now; the CDN then goes stale before
  // the held read lands. One that waits sees the halt once the read is in.
  const admittedFirst = await Promise.race([Promise.resolve(offer).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 20))]);
  if (admittedFirst) f.state.manifest = manifest({ seq: 5 });
  release();
  await Promise.all([check, offer]);
  f.state.manifest = manifest({ seq: 5 }); // the CDN serves the pre-halt copy
  f.states.length = 0;
  await f.ipc.invoke("update:check");
  assert.deepEqual(f.offered(), [LATEST]);
});
