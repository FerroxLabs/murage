// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 slice A: the splash page and its channels (tests A10 to A13c, A15, and the three layouts).
// The clock tests are in startup-timing.node-test.mjs; the shipped memory-upgrade page tests are in upgrade-screen.node-test.mjs.

import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createOwnedMainIpc, OWNED_MAIN_IPC_REFUSAL } from "./main-ipc-trust.mjs";
import { PICTURE_FILE, PICTURE_MAX_BYTES, readStartupPicture, validatePicture, writeStartupPicture } from "./startup-picture.mjs";
import { registerStartupIpc } from "./startup-ipc.mjs";
import { STARTUP_TEXT, createStartupSplash, splashPage } from "./startup-splash.mjs";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" width="30" height="30">${inner}</svg>`;
const FACE_A = svg(`<g id="FACE-A-MARKER"/><circle cx="15" cy="15" r="10" fill="#ff6b35"/>`);
const FACE_B = svg(`<g id="FACE-B-MARKER"/><circle cx="15" cy="13" r="10" fill="#ff6b35"/>`);
const picture = (extra = {}) => ({
  v: 1, tipNext: 3, faceA: FACE_A, faceB: FACE_B, at: 1760000000000,
  tip: { id: "search", head: "Find anything in a second", line: "Every chat is one search away.", try: "Press Cmd+K and type a name" },
  ...extra,
});
const page = (options) => decodeURIComponent(splashPage(options).split(",").slice(1).join(","));

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-splash-"));
  try { return fn(dir); } finally { safeWipeSync(dir); }
}
const save = (dir, value) => fs.writeFileSync(path.join(dir, PICTURE_FILE), typeof value === "string" ? value : JSON.stringify(value));

test("A10 picture: a good file reads back; missing, oversized, symlinked, wrong version and script-bearing SVG all read as null", () => {
  withDir((dir) => {
    assert.equal(readStartupPicture({ userData: dir }), null, "missing");
    save(dir, picture());
    assert.deepEqual(readStartupPicture({ userData: dir }), picture(), "a good file");
    assert.deepEqual(readStartupPicture({ userData: () => dir }), picture(), "the folder may be given lazily");
    assert.equal(readStartupPicture({ userData: "relative/path" }), null);
    assert.equal(readStartupPicture({}), null);

    save(dir, JSON.stringify(picture()) + " ".repeat(PICTURE_MAX_BYTES));
    assert.equal(readStartupPicture({ userData: dir }), null, "oversized");

    save(dir, picture({ v: 2 }));
    assert.equal(readStartupPicture({ userData: dir }), null, "wrong version");
    save(dir, "{not json");
    assert.equal(readStartupPicture({ userData: dir }), null, "unparseable");
    save(dir, picture({ tipNext: 12 }));
    assert.equal(readStartupPicture({ userData: dir }), null, "tip index out of range");
    save(dir, picture({ tip: { id: "Search!", head: "a", line: "b", try: "c" } }));
    assert.equal(readStartupPicture({ userData: dir }), null, "a tip id is a plain lowercase word");

    for (const [name, face] of [
      ["script element", svg(`<script>alert(1)</script>`)],
      ["event attribute", svg(`<circle r="3" onload="alert(1)"/>`)],
      ["foreignObject", svg(`<foreignObject><div/></foreignObject>`)],
      ["external image", svg(`<image href="https://example.invalid/x.png"/>`)],
      ["xlink external", svg(`<image xlink:href="http://example.invalid/x.png"/>`)],
      ["javascript href", svg(`<a href="javascript:alert(1)"><circle r="3"/></a>`)],
      ["external css url", svg(`<circle r="3" style="fill:url(https://example.invalid/x)"/>`)],
      ["doctype", `<!DOCTYPE svg [<!ENTITY x "y">]>${svg("")}`],
    ]) {
      save(dir, picture({ faceA: face }));
      assert.equal(readStartupPicture({ userData: dir }), null, name);
      save(dir, picture({ faceB: face }));
      assert.equal(readStartupPicture({ userData: dir }), null, `${name} (face B)`);
    }
    // what a real avatar can carry stays: a same-document gradient and an inlined photo
    const real = svg(`<defs><linearGradient id="g1"><stop offset="0" stop-color="#fff"/></linearGradient></defs><circle r="3" fill="url(#g1)"/><image href="data:image/png;base64,iVBORw0KGgo="/>`);
    save(dir, picture({ faceA: real }));
    assert.notEqual(readStartupPicture({ userData: dir }), null, "gradient and inlined photo are allowed");
  });
  withDir((dir) => {
    const target = path.join(dir, "elsewhere.json");
    fs.writeFileSync(target, JSON.stringify(picture()));
    try { fs.symlinkSync(target, path.join(dir, PICTURE_FILE)); } catch { return; }
    assert.equal(readStartupPicture({ userData: dir }), null, "symlinked");
  });
  withDir((dir) => {
    fs.mkdirSync(path.join(dir, PICTURE_FILE));
    assert.equal(readStartupPicture({ userData: dir }), null, "not a regular file");
  });
  assert.match(page({ mode: "tip", picture: null }), /viewBox="[^"]*" role="img" aria-label="Murage"/, "no picture: the default lockup shows");
  assert.doesNotMatch(page({ mode: "tip", picture: null }), /<image /, "and carries no face picture");
});

test("A10b the writer validates, writes owner-only through a temp file, and refuses a hostile picture", () => {
  withDir((dir) => {
    assert.equal(writeStartupPicture({ userData: dir, picture: picture({ faceA: svg("<script/>") }) }), false);
    assert.equal(fs.existsSync(path.join(dir, PICTURE_FILE)), false);
    assert.equal(writeStartupPicture({ userData: dir, picture: picture() }), true);
    assert.deepEqual(readStartupPicture({ userData: dir }), picture());
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, PICTURE_FILE)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), [PICTURE_FILE], "no temp file is left behind");
    assert.equal(writeStartupPicture({ userData: dir, picture: picture({ tip: { id: "search", head: "x".repeat(500), line: "b", try: "c" } }) }), false);
    assert.equal(validatePicture(null), null);
    assert.equal(validatePicture([]), null);
  });
});

test("A11 CSP is exactly default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:", () => {
  for (const options of [{}, { mode: "tip", picture: picture() }, { mode: "tip" }, { mode: "update", version: "1.0.19" }, { mode: "first" }]) {
    const html = page(options);
    assert.deepEqual([...html.matchAll(/http-equiv="Content-Security-Policy" content="([^"]*)"/g)].map((m) => m[1]), [CSP], JSON.stringify(options));
  }
});

test("A12 the picture is embedded only as an img data URI, never as markup", () => {
  const html = page({ mode: "tip", picture: picture() });
  const uriA = `data:image/svg+xml;base64,${Buffer.from(FACE_A).toString("base64")}`;
  const uriB = `data:image/svg+xml;base64,${Buffer.from(FACE_B).toString("base64")}`;
  assert.ok(html.includes(`href="${uriA}"`), "face A is an image source");
  assert.ok(html.includes(`href="${uriB}"`), "face B is an image source");
  assert.ok(!html.includes("FACE-A-MARKER") && !html.includes("FACE-B-MARKER"), "no part of a face is page markup");
  assert.ok(!html.includes(FACE_A) && !html.includes(FACE_B));
  assert.equal([...html.matchAll(/<image /g)].length, 2, "exactly the two faces, as images");
  assert.doesNotMatch(html, /<script(?![^>]*>\(\(\) =>)/, "the only script is the page's own");
});

test("the tip screen: two stacked lockups, the glyph and TIP, the tip in the person's words, and the strip", () => {
  const html = page({ mode: "tip", picture: picture(), language: "en-US", platform: "darwin" });
  assert.match(html, /data-layout="tip"/);
  assert.equal([...html.matchAll(/xmlns="http:\/\/www.w3.org\/2000\/svg" width="[0-9.]+" height="[0-9.]+" viewBox="[^"]*" role="img" aria-label="Murage"/g)].length, 2, "image A and image B");
  assert.match(html, /<div class="eb"><svg class="gl"[^>]*>.*?<\/svg>TIP<\/div>/);
  assert.match(html, /<h3>Find anything in a second<\/h3><p>Every chat is one search away\.<\/p><div class="try">Try it: Press Cmd\+K and type a name<\/div>/);
  assert.match(html, /id="pb"/);
  assert.match(html, /id="p">Starting Murage</);
  assert.match(html, /body\[data-fade\] \.lkb\{opacity:1;transition:opacity 800ms/);
  assert.match(html, /prefers-reduced-motion:reduce[^}]*\}[^<]*\.lkb\{transition:none!important\}/);
});

test("no picture yet: the tip still shows, with the bundled lockup and a tip that names nobody, in the system language", () => {
  const mac = page({ mode: "tip", picture: null, platform: "darwin" });
  assert.match(mac, /<h3>Find anything in a second<\/h3>/);
  assert.match(mac, /Press Cmd\+K and type a name/);
  assert.match(page({ mode: "tip", picture: null, platform: "win32" }), /Press Ctrl\+K and type a name/);
  const de = page({ mode: "tip", picture: null, language: "de-DE", platform: "linux" });
  assert.match(de, /<h3>Alles in einer Sekunde finden<\/h3>/);
  assert.match(de, /TIPP/);
  assert.match(de, /Drücke Ctrl\+K und tippe einen Namen/);
});

test("the update screen: the Chief's face, Finishing the update, the one true line, the version and one What's new button", () => {
  const html = page({ mode: "update", picture: picture(), version: "1.0.19", language: "en" });
  assert.match(html, /data-layout="update"/);
  assert.match(html, /<h1 id="t">Finishing the update<\/h1>/);
  assert.ok(html.includes(`<div class="n" id="n">${STARTUP_TEXT.en.note}</div>`));
  assert.match(html, /Murage 1\.0\.19 · <\/span><span id="p">Starting Murage</);
  assert.equal([...html.matchAll(/id="wn"/g)].length, 1);
  assert.match(html, /<button type="button" id="wn" class="pill">What&#39;s new<\/button>/);
  assert.equal([...html.matchAll(/xmlns="http:\/\/www.w3.org\/2000\/svg" width="[0-9.]+" height="[0-9.]+" viewBox="[^"]*" role="img" aria-label="Murage"/g)].length, 1);
  assert.doesNotMatch(page({ mode: "tip", picture: picture() }), /id="wn"/, "only the update screen has the button");
  const de = page({ mode: "update", version: "1.0.19", language: "de" });
  assert.ok(de.includes(STARTUP_TEXT.de.updating) && de.includes(STARTUP_TEXT.de.whatsNew) && de.includes(STARTUP_TEXT.de.note));
});

test("the first-load screen: the lockup alone, still, with the strip", () => {
  const html = page({ mode: "first" });
  assert.match(html, /data-layout="first"/);
  assert.equal([...html.matchAll(/xmlns="http:\/\/www.w3.org\/2000\/svg" width="[0-9.]+" height="[0-9.]+" viewBox="[^"]*" role="img" aria-label="Murage"/g)].length, 1);
  assert.doesNotMatch(html, /<h3>|class="try"|id="wn"|<image /);
  assert.match(html, /id="pb"/);
});

test("the shipped page keeps its markup when there is no mode (the memory-upgrade window)", () => {
  const html = page({ language: "en", note: true });
  assert.match(html, /data-layout="classic"/);
  assert.ok(html.includes(STARTUP_TEXT.en.note));
  assert.doesNotMatch(html, /class="hero /, "no new hero on the shipped page");
});

test("the text tables carry the new labels in every language, plainly", () => {
  const BANNED = /[—–]|\b(safe|free|forge)\b/i;
  for (const [code, table] of Object.entries(STARTUP_TEXT)) {
    for (const key of ["tip", "tryIt", "updating", "whatsNew"]) assert.ok(typeof table[key] === "string" && table[key].length > 0, `${code}.${key}`);
    for (const key of ["head", "line", "try"]) assert.ok(typeof table.defaultTip[key] === "string" && table.defaultTip[key].length > 0, `${code}.defaultTip.${key}`);
    assert.ok(table.defaultTip.try.includes("{key}"), `${code}: the shortcut is a placeholder`);
    for (const text of [table.tip, table.tryIt, table.updating, table.whatsNew, ...Object.values(table.defaultTip)]) assert.doesNotMatch(text, BANNED, `${code}: ${text}`);
  }
});

// ---- the title channel

function titleFixture(options = {}) {
  const handlers = {};
  let minimized = 0, quit = 0, whatsNew = 0, prevented = 0;
  class Window {
    constructor() { this.webContents = { setWindowOpenHandler() {}, on: (name, fn) => { handlers[name] = fn; }, executeJavaScript: () => Promise.resolve() }; }
    on() {} loadURL() { return Promise.resolve(); } setSize() {} center() {} setMinimizable() {} setSkipTaskbar() {} show() {}
    minimize() { minimized++; } isDestroyed() { return false; } destroy() {}
  }
  const splash = createStartupSplash({ BrowserWindow: Window, onUserClose: () => { quit++; }, onWhatsNew: () => { whatsNew++; }, ...options });
  const title = (value) => handlers["page-title-updated"]({ preventDefault() { prevented++; } }, value);
  return { splash, title, counts: () => ({ minimized, quit, whatsNew, prevented }) };
}

test("A13 title channel: minimize always minimizes, quit acts only while upgrading, whatsnew only sets the flag (never quits), anything else is ignored", () => {
  const f = titleFixture({ mode: "update" });
  f.title("murage-splash:minimize:1");
  f.title("murage-splash:quit:2");
  f.title("murage-splash:whatsnew:3");
  assert.deepEqual(f.counts(), { minimized: 1, quit: 0, whatsNew: 1, prevented: 3 }, "no quit before an upgrade view is up; whatsnew reached its own callback");
  f.splash.set({ mode: "blocking", keepOpen: true });
  f.title("murage-splash:whatsnew:4");
  assert.equal(f.counts().quit, 0, "whatsnew never falls into the quit branch, even while upgrading");
  assert.equal(f.counts().whatsNew, 2);
  f.title("murage-splash:quit:5");
  assert.equal(f.counts().quit, 1);
  f.title("murage-splash:minimize:6");
  assert.equal(f.counts().minimized, 2);
  const before = f.counts();
  for (const other of ["Something else", "murage-splash:format:7", "murage-splash:whatsnew", "murage-splash:whatsnew:x", "murage-splash:quit:1:2", "xmurage-splash:quit:1", "murage-splash:WHATSNEW:1", undefined, null, 5]) f.title(other);
  assert.deepEqual(f.counts(), before, "anything else is ignored and not even prevented");
});

test("A13b a tip, Chief name or glyph carrying markup or a title-channel string renders as text and sends nothing", () => {
  const hostile = `<img src=x onerror=alert(1)> murage-splash:quit:1`;
  const html = page({ mode: "tip", picture: picture({ tip: { id: "search", head: hostile, line: `</p><script>1</script>`, try: `"><b onmouseover=1>` } }) });
  assert.ok(!html.includes("<img src=x"), "the tag is escaped");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt; murage-splash:quit:1"));
  assert.ok(html.includes("&lt;/p&gt;&lt;script&gt;1&lt;/script&gt;"));
  assert.ok(html.includes("&quot;&gt;&lt;b onmouseover=1&gt;"));
  assert.match(html, /<title>Murage<\/title>/, "the page title (the channel) is never data");
  assert.equal([...html.matchAll(/murage-splash:/g)].length, 1 + [...html.matchAll(/document\.title = "murage-splash:/g)].length, "the one string in the tip text is inert text, not a title assignment");
  // a glyph id that is not a known word never reaches markup (the glyph is keyed, not interpolated)
  const odd = page({ mode: "tip", picture: picture({ tip: { id: "constructor", head: "a", line: "b", try: "c" } }) });
  assert.doesNotMatch(odd, /function Object/);
});

test("A13c startup-picture:save from any webContents other than the main window is refused", async () => {
  await withDirAsync(async (dir) => {
    const handlers = new Map();
    const electronIpc = { handle: (channel, fn) => handlers.set(channel, fn), on() {} };
    const mainContents = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, isLoadingMainFrame: () => false, sent: [], send(channel) { this.sent.push(channel); } });
    const other = { id: 2 };
    const gate = createOwnedMainIpc({ ipcMain: electronIpc, isTrusted: (event) => event?.sender === mainContents });
    const startup = registerStartupIpc({ gate, userData: dir, getMainContents: () => mainContents });
    assert.deepEqual([...handlers.keys()].sort(), ["startup-picture:save", "startup-picture:session-tip", "startup:ack-whats-new", "startup:pending-whats-new"]);
    for (const channel of handlers.keys()) {
      await assert.rejects(async () => handlers.get(channel)({ sender: other }, picture()), (error) => error.code === OWNED_MAIN_IPC_REFUSAL, `${channel} refused from another window`);
      await assert.rejects(async () => handlers.get(channel)({}, picture()), (error) => error.code === OWNED_MAIN_IPC_REFUSAL, `${channel} refused with no sender`);
    }
    assert.equal(fs.existsSync(path.join(dir, PICTURE_FILE)), false, "a refused sender writes nothing");
    assert.equal(await handlers.get("startup-picture:save")({ sender: mainContents }, picture()), true);
    assert.deepEqual(readStartupPicture({ userData: dir }), picture());
    assert.equal(await handlers.get("startup-picture:save")({ sender: mainContents }, { v: 1 }), false, "an invalid payload from the main window is dropped");
    assert.equal(await handlers.get("startup-picture:save")({ sender: mainContents }, "text"), false);
    assert.deepEqual(readStartupPicture({ userData: dir }), picture(), "the good picture is untouched");

    // What's new: held until the renderer acknowledges it
    assert.equal(await handlers.get("startup:pending-whats-new")({ sender: mainContents }), false);
    startup.requestWhatsNew();
    assert.deepEqual(mainContents.sent, ["startup:whats-new"], "delivered at once when the page can hear it");
    assert.equal(await handlers.get("startup:pending-whats-new")({ sender: mainContents }), true, "still pending until acknowledged");
    startup.deliver();
    assert.equal(mainContents.sent.length, 2, "a reload re-delivers");
    assert.equal(await handlers.get("startup:ack-whats-new")({ sender: mainContents }), true);
    startup.deliver();
    assert.equal(mainContents.sent.length, 2, "nothing after the acknowledgement");
    assert.equal(await handlers.get("startup:pending-whats-new")({ sender: mainContents }), false);
  });
});

test("What's new pressed before the main window can hear it is kept and delivered when it loads", () => {
  let loading = true;
  const sent = [];
  const gate = { handle() {} };
  const contents = { isDestroyed: () => false, isLoadingMainFrame: () => loading, send: (channel) => sent.push(channel) };
  let current = null;
  const startup = registerStartupIpc({ gate, userData: "/x", getMainContents: () => current });
  startup.requestWhatsNew();
  assert.deepEqual(sent, [], "no window yet");
  current = contents;
  startup.deliver();
  assert.deepEqual(sent, [], "window still loading");
  loading = false;
  startup.deliver();
  assert.deepEqual(sent, ["startup:whats-new"]);
});

test("A15 every page string is escaped (a Chief named <img src=x onerror=1> renders as text)", () => {
  const name = "<img src=x onerror=1>";
  const html = page({
    mode: "tip", language: `en"><img src=x onerror=1>`, version: name,
    picture: picture({ tip: { id: "search", head: `${name} is ready`, line: `${name} reads your mail`, try: `Ask @${name}` } }),
  });
  assert.ok(!html.includes("<img src=x"), "no raw tag anywhere in the page");
  assert.ok(html.includes("&lt;img src=x onerror=1&gt; is ready"));
  assert.ok(html.includes("&lt;img src=x onerror=1&gt; reads your mail"));
  assert.ok(html.includes("Ask @&lt;img src=x onerror=1&gt;"));
  const update = page({ mode: "update", version: name });
  assert.ok(!update.includes("<img src=x"));
  assert.ok(update.includes(`Murage ${"&lt;img src=x onerror=1&gt;"} · `));
});

async function withDirAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-splash-"));
  try { return await fn(dir); } finally { safeWipeSync(dir); }
}
