// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.19 notify envelope, Linux side: the banner shows exactly the text that gets approved, carries Allow, Deny and Open (Reply only
// where the server has inline reply), is bound to the exact pending card the server named, and is Open only everywhere else.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as linuxNotify from "./linux-notify.mjs";

const { createLinuxBanners, SURFACE } = linuxNotify;
const tick = () => new Promise(resolve => setImmediate(resolve));
const BINDING = { approvalId: "ap-1", requestRef: "ref-1", actionHash: "c".repeat(64) };
const card = (willRun = "node --check example.mjs", over = {}) => ({ display: { botName: "Ada", title: "Run a command", willRun },
  outsideOk: { [SURFACE]: true }, digest: "d".repeat(64), ...BINDING, ...over });
const target = { botId: "b1", threadId: "t1", messageId: "m1" };
const GNOME = ["gnome-shell", "GNOME", "46.0", "1.2"], PLASMA = ["Plasma", "KDE", "6.1.0", "1.2"];

function rig({ capabilities = ["actions", "body", "body-markup"], server = GNOME, language = "en", frame = {}, owners = [":1.42"], names: namesMode = "present", twoDaemons = false } = {}) {
  const posted = [], closed = [], minted = [], acted = [], opened = [], destinations = [];
  // A second daemon (:1.99) that can take the name. `takeover()` hands it the name the way the bus does: at once for every message
  // addressed to the well-known name, while the NameOwnerChanged signal is still on its way to this client.
  const other = new EventEmitter(), otherPosted = [], otherClosed = [];
  let current = null;
  let infoCalls = 0, disconnects = 0, connections = 0, ownerReads = 0;
  const buses = [], logs = [];
  const iface = new EventEmitter();
  // The daemon behind the name. A test that replaces the daemon changes what it answers.
  const daemon = { capabilities, server, postWait: null };
  iface.GetCapabilities = async () => daemon.capabilities;
  if (server !== "absent") iface.GetServerInformation = async () => { infoCalls += 1; if (daemon.server === "throws") throw new Error("gone"); return daemon.server; };
  iface.Notify = async (...args) => { posted.push(args); const id = posted.length; if (daemon.postWait) await daemon.postWait; return id; };
  iface.CloseNotification = async id => { closed.push(id); };
  other.GetCapabilities = async () => daemon.capabilities;
  other.GetServerInformation = async () => daemon.server;
  other.Notify = async (...args) => { otherPosted.push(args); return 900 + otherPosted.length; };
  other.CloseNotification = async id => { otherClosed.push(id); };
  current = iface;
  // What the bus does with the well-known name: each call goes to whichever daemon owns the name at that moment.
  const wellKnown = { GetCapabilities: () => current.GetCapabilities(), GetServerInformation: () => current.GetServerInformation(),
    Notify: (...args) => current.Notify(...args), CloseNotification: id => current.CloseNotification(id),
    on: (name, listener) => iface.on(name, listener), removeListener: (name, listener) => iface.removeListener(name, listener) };
  const banners = createLinuxBanners({ platform: "linux", language: () => language,
    log: line => logs.push(line),
    loadBus: () => {
      connections += 1;
      const bus = new EventEmitter(), names = new EventEmitter();
      bus.names = names;
      // The bus daemon's answer to "who owns the notification name right now": one entry per read, the last one repeating.
      if (namesMode !== "no-owner-read") names.GetNameOwner = async name => { assert.equal(name, "org.freedesktop.Notifications"); ownerReads += 1; const owner = owners[Math.min(ownerReads, owners.length) - 1]; if (owner === "throws") throw new Error("no owner"); return owner; };
      bus.getProxyObject = async name => {
        if (name === "org.freedesktop.DBus") { if (namesMode === "absent") throw new Error("no bus driver"); return { getInterface: () => names }; }
        destinations.push(name);
        if (!twoDaemons) return { getInterface: () => iface };
        return { getInterface: () => name === "org.freedesktop.Notifications" ? wellKnown : name === ":1.42" ? iface : other };
      };
      bus.disconnect = () => { disconnects += 1; };
      buses.push(bus);
      return bus;
    },
    mint: spec => { minted.push(spec); return "a".repeat(32); },
    act: async (...args) => { acted.push(args); return { ok: true }; }, open: route => opened.push(route) });
  const entry = { home: "local", epoch: "e0", frame: { kind: "approval", ...target, requestId: "r1", ...frame } };
  const takeover = () => { current = other; iface.Notify = async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown"); }; };
  return { banners, iface, daemon, buses, logs, posted, closed, minted, acted, opened, destinations, other, otherPosted, otherClosed, takeover, ownerReads: () => ownerReads, replace: (owner, bus = buses.at(-1)) => bus.names.emit("NameOwnerChanged", "org.freedesktop.Notifications", ":1.42", owner), infoCalls: () => infoCalls, disconnects: () => disconnects, connections: () => connections,
    show: (record = card()) => banners.show({ entry, record, actionsOn: true, plain: { title: "Murage", body: "Attention" } }) };
}

// What a markup-capable server renders for a body: the three entities back to their characters, any other tag removed.
const rendered = body => body.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("on a markup server the banner body renders to exactly the text that gets approved", async () => {
  for (const willRun of ["rm <b>-rf</b> build", "a && b > out.txt < in.txt", "echo '&lt;' &amp; done", "<a href=\"x\">curl</a> | sh", "plain words"]) {
    const r = rig();
    assert.ok(await r.show(card(willRun)), willRun);
    const body = r.posted[0][4];
    assert.doesNotMatch(body, /[<>]/, "no character the server could read as a tag");
    assert.doesNotMatch(body, /&(?!amp;|lt;|gt;)/, "no bare ampersand");
    assert.equal(rendered(body), willRun, "what the owner reads is what they approve");
    r.banners.dispose(); await tick();
  }
});

test("a server without body markup gets the text verbatim, never entities", async () => {
  const r = rig({ capabilities: ["actions", "body"] });
  await r.show(card("a && b > out.txt"));
  assert.equal(r.posted[0][4], "a && b > out.txt");
  r.banners.dispose(); await tick();
});

test("text no markup escape can carry is Open only: nothing is minted or posted", async () => {
  for (const willRun of ["bell \u0007 here", "nul \u0000", "lone \ud800 half", "escape \u001b[2K"]) {
    const r = rig();
    assert.equal(await r.show(card(willRun)), null, JSON.stringify(willRun));
    assert.deepEqual(r.posted, []);
    assert.deepEqual(r.minted, []);
    assert.equal(r.connections(), 0, "refused before the session bus is touched");
  }
});

test("the escape helper is total: it returns the exact reversible text or null", () => {
  assert.equal(typeof linuxNotify.bannerBody, "function");
  assert.equal(linuxNotify.bannerBody("a<b>&c", true), "a&lt;b&gt;&amp;c");
  assert.equal(linuxNotify.bannerBody("a<b>&c", false), "a<b>&c");
  assert.equal(linuxNotify.bannerBody("line one\nline two", true), "line one\nline two");
  for (const bad of [undefined, null, 7, "", "tab\u000bstop", "￾"]) assert.equal(linuxNotify.bannerBody(bad, true), null);
  assert.equal(linuxNotify.bannerBody("bell \u0007", false), null, "controls are refused with or without markup");
});

test("the banner offers Allow, Deny and Open, with the body click opening the card", async () => {
  const r = rig();
  await r.show();
  assert.deepEqual(r.posted[0][5], ["default", "Open", "allow", "Allow", "deny", "Deny", "open", "Open"]);
  r.iface.emit("ActionInvoked", 1, "open"); await tick();
  assert.deepEqual(r.opened, [target]);
  assert.deepEqual(r.acted, [], "Open never answers");
  assert.deepEqual(r.closed, [1]);
});

test("Reply is offered only where the server has inline reply, under the protocol's inline-reply key", async () => {
  const none = rig({ server: PLASMA, capabilities: ["actions", "body", "body-markup"] });
  await none.show();
  assert.ok(!none.posted[0][5].some(word => /reply/i.test(word)), "no Reply without the capability");
  none.banners.dispose(); await tick();

  const r = rig({ server: PLASMA, capabilities: ["actions", "body", "body-markup", "inline-reply"] });
  await r.show();
  assert.deepEqual(r.posted[0][5], ["default", "Open", "allow", "Allow", "deny", "Deny", "inline-reply", "Reply", "open", "Open"]);
  r.iface.emit("ActionInvoked", 1, "inline-reply"); await tick();
  assert.deepEqual(r.acted, [], "activating the editor is not an answer");
  assert.equal(r.banners.size(), 1);
  r.iface.emit("NotificationReplied", 1, "not today"); await tick();
  assert.deepEqual(r.acted, [["a".repeat(32), "reply", "not today"]]);
  assert.deepEqual(r.closed, [1]);
});

test("the Open word is the catalogue's, in all eight languages", () => {
  for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    const pack = JSON.parse(readFileSync(new URL(`../src/locales/${code}.json`, import.meta.url), "utf8"));
    assert.equal(linuxNotify.openLabel(code), pack["trayPanel.open"], code);
  }
  assert.equal(linuxNotify.openLabel("pt_PT"), "Abrir");
  for (const tag of ["unknown", null, "__proto__"]) assert.equal(linuxNotify.openLabel(tag), "Open");
});

test("only a qualified notification server gets an actionable banner", async () => {
  assert.deepEqual([...linuxNotify.QUALIFIED_SERVERS].sort(), ["Plasma", "gnome-shell"]);
  for (const server of [GNOME, PLASMA]) {
    const r = rig({ server });
    assert.ok(await r.show(), server[0]);
    await r.show();
    assert.equal(r.infoCalls(), 1, "asked once per connection");
    r.banners.dispose(); await tick();
  }
  for (const server of [["dunst", "knopwob", "1.9", "1.2"], ["GNOME-SHELL", "GNOME", "46", "1.2"], ["gnome-shell-x", "", "", ""], [], "gnome-shell", { 0: "gnome-shell", length: 4 }, null, [["gnome-shell"]], "throws", "absent"]) {
    const r = rig({ server });
    assert.equal(await r.show(), null, JSON.stringify(server));
    assert.deepEqual(r.posted, [], JSON.stringify(server));
    assert.deepEqual(r.minted, [], JSON.stringify(server));
    assert.equal(r.disconnects(), 1, "the idle connection is released");
  }
});

test("a card without the server's three binding fields is Open only", async () => {
  for (const over of [{ approvalId: undefined }, { requestRef: undefined }, { actionHash: undefined }, { approvalId: "" }, { requestRef: 7 }, { actionHash: "" }]) {
    const r = rig();
    assert.equal(await r.show(card(undefined, over)), null, JSON.stringify(over));
    assert.deepEqual(r.posted, []);
    assert.deepEqual(r.minted, []);
    assert.equal(r.connections(), 0, "refused before the session bus is touched");
  }
});

test("the token is minted for the card the server named, and a frame that names another card is refused", async () => {
  const r = rig();
  await r.show();
  const { approvalId, requestRef, actionHash, requestId, threadId, messageId } = r.minted[0].entry.frame;
  assert.deepEqual({ approvalId, requestRef, actionHash }, BINDING);
  assert.deepEqual({ requestId, threadId, messageId }, { requestId: "r1", threadId: "t1", messageId: "m1" });
  r.banners.dispose(); await tick();

  const same = rig({ frame: { ...BINDING } });
  assert.ok(await same.show(), "a frame that agrees with the server is fine");
  same.banners.dispose(); await tick();

  for (const frame of [{ approvalId: "ap-other" }, { requestRef: "ref-other" }, { actionHash: "e".repeat(64) }]) {
    const other = rig({ frame });
    assert.equal(await other.show(), null, JSON.stringify(frame));
    assert.deepEqual(other.minted, []);
    assert.deepEqual(other.posted, []);
  }
});

test("the summary is sent as the plain text it is, and the card the fit was judged on is not rewritten", async () => {
  const r = rig();
  const record = card("a < b && c", { display: { botName: "R&D", title: "Run <one> command", willRun: "a < b && c" } });
  const before = JSON.stringify(record);
  assert.ok(await r.show(record));
  assert.equal(r.posted[0][3], "R&D: Run <one> command", "the summary is never markup in the notification protocol");
  assert.equal(r.posted[0][4], "a &lt; b &amp;&amp; c");
  assert.equal(JSON.stringify(record), before, "escaping happens on the wire only: digest and fit stay on the unescaped text");
  assert.equal(r.minted[0].digest, record.digest);
  r.banners.dispose(); await tick();
});

test("no polling: an idle banner service holds no connection, and one connection serves every banner", async () => {
  const r = rig();
  assert.equal(r.connections(), 0, "nothing connects before the first actionable card");
  await r.show(); await r.show(); await r.show();
  assert.equal(r.connections(), 1);
  assert.equal(r.infoCalls(), 1);
  r.banners.close(r.minted.map(spec => spec.surfaceId)); await tick();
  assert.equal(r.disconnects(), 1, "released as soon as the last banner is gone");
  assert.equal(r.banners.size(), 0);
});

// Reviewer High 1: qualification belongs to one daemon (the unique owner of the service name), never to the name.
test("a replaced notification daemon inherits nothing: routes, ids, markup and reply assumptions all end with the old owner", async () => {
  const r = rig({ capabilities: ["actions", "body", "body-markup", "inline-reply"], server: PLASMA });
  assert.ok(await r.show(card("a && b > out.txt")));
  assert.equal(r.posted[0][4], "a &amp;&amp; b &gt; out.txt");
  assert.ok(r.posted[0][5].includes("inline-reply"));
  // The daemon restarts as one with no markup and no inline reply; the bus tells every client the name has a new owner.
  r.daemon.capabilities = ["actions", "body"];
  r.replace(":1.99");
  assert.equal(r.banners.size(), 0, "the old daemon's banner routes are dropped at once");
  assert.equal(r.disconnects(), 1, "and its connection is released");
  assert.ok(r.logs.includes("linux-notify: notification server replaced"));
  r.iface.emit("ActionInvoked", 1, "allow");
  r.iface.emit("NotificationReplied", 1, "yes"); await tick();
  assert.deepEqual(r.acted, [], "an id the old daemon handed out answers nothing on the new one");
  assert.equal(r.buses[0].names.listenerCount("NameOwnerChanged"), 0, "the watch goes with the connection");
  assert.ok(await r.show(card("a && b > out.txt")));
  assert.equal(r.connections(), 2, "the next banner qualifies the new daemon on a fresh connection");
  assert.equal(r.infoCalls(), 2);
  assert.equal(r.posted[1][4], "a && b > out.txt", "verbatim: the old daemon's markup is not assumed");
  assert.ok(!r.posted[1][5].includes("inline-reply"), "and neither is its inline reply");
  r.banners.dispose(); await tick();
});

test("a replacement daemon that is not qualified leaves every later card Open only", async () => {
  const r = rig();
  assert.ok(await r.show());
  r.daemon.server = ["dunst", "knopwob", "1.9", "1.2"];
  r.replace(":1.99");
  assert.equal(await r.show(), null);
  assert.equal(r.posted.length, 1, "nothing is posted to the unqualified daemon");
  assert.equal(r.minted.length, 1, "and no token is minted for it");
  // The name falling vacant (no new owner) ends the old daemon's routes the same way.
  const gone = rig();
  await gone.show();
  gone.replace("");
  assert.equal(gone.banners.size(), 0);
  gone.iface.emit("ActionInvoked", 1, "allow"); await tick();
  assert.deepEqual(gone.acted, []);
});

test("a daemon replaced while a banner is being posted leaves no answerable route", async () => {
  const r = rig();
  let release;
  r.daemon.postWait = new Promise(resolve => { release = resolve; });
  const showing = r.show();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(r.posted.length, 1, "the post is in flight");
  r.replace(":1.99");
  release();
  assert.equal(await showing, null);
  assert.equal(r.banners.size(), 0);
  r.iface.emit("ActionInvoked", 1, "allow"); await tick();
  assert.deepEqual(r.acted, []);
});

test("the owner is read before and after qualification: a change in between, or no unique owner, is Open only", async () => {
  for (const options of [{ owners: [":1.42", ":1.77"] }, { owners: ["org.freedesktop.Notifications"] }, { owners: [""] }, { owners: [null] }, { owners: [":1.42", "throws"] }, { owners: ["throws", ":1.42"] },
    { owners: ["throws"] }, { names: "absent" }, { names: "no-owner-read" }]) {
    const r = rig(options);
    assert.equal(await r.show(), null, JSON.stringify(options));
    assert.deepEqual(r.posted, [], JSON.stringify(options));
    assert.deepEqual(r.minted, [], JSON.stringify(options));
    assert.equal(r.disconnects(), 1, "the idle connection is released");
  }
  const steady = rig();
  assert.ok(await steady.show());
  assert.equal(steady.ownerReads(), 2, "once before the capability reads and once after them");
  await steady.show();
  assert.equal(steady.ownerReads(), 2, "per connection, never per banner");
  steady.banners.dispose(); await tick();
});

test("control: an owner change for another name, or a signal that names the same owner, keeps the banner", async () => {
  const r = rig();
  await r.show();
  r.buses[0].names.emit("NameOwnerChanged", "org.example.Other", ":1.5", ":1.6");
  r.replace(":1.42");
  assert.equal(r.banners.size(), 1);
  assert.equal(r.disconnects(), 0);
  r.iface.emit("ActionInvoked", 1, "deny"); await tick();
  assert.deepEqual(r.acted, [["a".repeat(32), "deny", undefined]]);
});

// Reviewer Medium: the executable detail lives in the body, so a server that shows only the summary cannot carry an answer.
test("a summary-only server (actions without body) is Open only", async () => {
  for (const capabilities of [["actions"], ["actions", "inline-reply"], ["actions", "body-markup"], ["actions", "body-images", "body-hyperlinks"]]) {
    const r = rig({ capabilities });
    assert.equal(await r.show(), null, JSON.stringify(capabilities));
    assert.deepEqual(r.posted, []);
    assert.deepEqual(r.minted, []);
  }
  const r = rig({ capabilities: ["actions", "body"] });
  assert.ok(await r.show());
  r.banners.dispose(); await tick();
});

// Reviewer Medium: the banner is addressed to the daemon that was qualified, never to whoever holds the name when the message arrives.
test("every call after the owner read is addressed to the qualified daemon's unique name", async () => {
  const r = rig();
  assert.ok(await r.show());
  assert.deepEqual(r.destinations, [":1.42"], "capabilities, server information, Notify and CloseNotification all use the one proxy for the owner that was read");
  assert.ok(!r.destinations.includes("org.freedesktop.Notifications"), "the well-known name is only ever asked who owns it");
  r.banners.dispose(); await tick();
});

test("a daemon that takes the name between qualification and the post never receives the banner", async () => {
  const r = rig({ twoDaemons: true });
  assert.ok(await r.show(), "the first card qualifies :1.42 and posts to it");
  assert.equal(r.posted.length, 1);
  // The name changes hands on the bus; the signal that says so has not reached this client yet.
  r.takeover();
  assert.equal(await r.show(card("second && command")), null, "the qualified daemon is gone: the card falls back to the plain notice");
  assert.deepEqual(r.otherPosted, [], "the daemon that took the name was never qualified and is shown nothing");
  assert.equal(r.minted.length, 2, "the token minted for the lost post answers nothing: no route was kept for it");
  assert.equal(r.banners.size(), 1, "only the first banner has a route");
  // The signal arrives: the first banner's route goes too, and the new daemon's own callbacks answer nothing.
  r.replace(":1.99");
  assert.equal(r.banners.size(), 0);
  r.other.emit("ActionInvoked", 901, "allow"); r.iface.emit("ActionInvoked", 1, "allow"); await tick();
  assert.deepEqual(r.acted, []);
  assert.deepEqual(r.otherClosed, [], "and nothing is sent to it afterwards either");
});

test("control: with the name still held by the qualified daemon, the same two cards both post to it", async () => {
  const r = rig({ twoDaemons: true });
  assert.ok(await r.show());
  assert.ok(await r.show(card("second && command")));
  assert.equal(r.posted.length, 2);
  assert.deepEqual(r.otherPosted, []);
  r.iface.emit("ActionInvoked", 2, "allow"); await tick();
  assert.equal(r.acted.length, 1, "and its callbacks still answer");
  r.banners.dispose(); await tick();
});
