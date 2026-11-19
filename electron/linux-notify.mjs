// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// NOTIFY-EVERYWHERE-1019 S4c. One session connection while actionable banners exist.
// Electron and the action authority are injected; fallback banners belong to the caller.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { nativeBannerLabels } from "./native-banner-labels.mjs";

export const SURFACE = "banner-linux";
const SERVICE = "org.freedesktop.Notifications";
const PATH = "/org/freedesktop/Notifications";
const BUS = "org.freedesktop.DBus";
const BUS_PATH = "/org/freedesktop/DBus";
const MAX_ROUTES = 1024;
/** The notification servers whose banner rendering is qualified (GetServerInformation name, exact). Any other server is Open only.
 *  The name is self-reported: this is a rendering-qualification list, not a security boundary. Authority stays with the action path
 *  (token, lock, digest, the server's binding check). */
export const QUALIFIED_SERVERS = Object.freeze(["gnome-shell", "Plasma"]);
const BINDING = Object.freeze(["approvalId", "requestRef", "actionHash"]);
// Nothing a markup parser could drop, reinterpret or refuse: C0 controls except the line break, U+FFFE, U+FFFF and unpaired surrogates.
const UNCARRIABLE = /[\u0000-\u0009\u000B-\u001F\u007F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Packaged snapshot of src/locales/{language}.json trayPanel.open. The Node test checks every word against the renderer catalogue.
const OPEN_WORDS = { en: "Open", de: "Öffnen", es: "Abrir", fr: "Ouvrir", hi: "खोलें", ja: "開く", "pt-br": "Abrir", zh: "打开" };

export function openLabel(language = "en") {
  const tag = typeof language === "string" ? language.trim().toLowerCase().replace(/_/g, "-") : "en";
  const base = tag.split("-")[0];
  return OPEN_WORDS[Object.hasOwn(OPEN_WORDS, tag) ? tag : base === "pt" ? "pt-br" : Object.hasOwn(OPEN_WORDS, base) ? base : "en"];
}

/**
 * The Notify body for `text`: verbatim for a server without body markup, entity-escaped for one with it, so the rendered banner is
 * character for character the detail the answer approves. Null when the text cannot be carried exactly (the banner is Open only then).
 */
export function bannerBody(text, markup) {
  if (typeof text !== "string" || text.length === 0 || UNCARRIABLE.test(text)) return null;
  if (markup !== true) return text;
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Proof, not hope: undoing the three entities must give the text back, and no tag opener may survive.
  const shown = escaped.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return shown === text && !/[<>]/.test(escaped) ? escaped : null;
}

/** Loaded only for an actionable post. The integrator supplies the pinned dependency. */
export function loadSessionBus() {
  const { sessionBus, Variant } = createRequire(import.meta.url)("./vendor/dbus-next.cjs");
  const bus = sessionBus();
  // Keep the library's Variant constructor with its bus, so injected buses need no package.
  bus.notificationVariant = (signature, value) => new Variant(signature, value);
  return bus;
}

// Resolving the optional dependency does not evaluate it or open a connection.
loadSessionBus.available = () => {
  try { createRequire(import.meta.url).resolve("./vendor/dbus-next.cjs"); return true; } catch { return false; }
};

export function createLinuxBanners({ platform = process.platform, loadBus, mint, act, open, mute = () => {}, log = () => {}, language = () => "en" }) {
  const routes = new Map(); // mb id -> { connection, serverId, token, route, reply, consumed }
  let connection = null, disposed = false;
  const report = stage => { try { log(`linux-notify: ${stage}`); } catch { /* logging cannot interrupt cleanup */ } };

  function available() {
    if (disposed || platform !== "linux" || typeof loadBus !== "function") return false;
    try { return typeof loadBus.available !== "function" || loadBus.available() === true; } catch { return false; }
  }

  function disconnect(c) {
    if (c.dead) return;
    c.dead = true;
    if (connection === c) connection = null;
    for (const [name, listener] of c.listeners) {
      try { c.iface?.removeListener(name, listener); } catch { /* connection may already be gone */ }
    }
    c.listeners.length = 0;
    if (c.watch) {
      try { c.names?.removeListener("NameOwnerChanged", c.watch); } catch { /* connection may already be gone */ }
      c.watch = null;
    }
    for (const id of c.ids.values()) routes.delete(id);
    c.ids.clear();
    try { c.bus?.disconnect(); } catch { /* connection may already be gone */ }
    // Retain the error listener until the bus is collected: late socket errors must be contained.
    // It captures no card content and is inert once c.dead is set.
  }

  function releaseIfIdle(c) {
    if (c.pending === 0 && c.operations === 0 && c.ids.size === 0) disconnect(c);
  }

  function forget(id) {
    const route = routes.get(id);
    if (!route) return null;
    routes.delete(id);
    route.connection.ids.delete(route.serverId);
    return route;
  }

  function withdraw(c, serverId) {
    if (c.dead || !c.iface) return Promise.resolve();
    c.operations += 1;
    let closing;
    try { closing = c.iface.CloseNotification(serverId); } catch { closing = undefined; }
    return Promise.resolve(closing).catch(() => {}).finally(() => {
      c.operations -= 1;
      releaseIfIdle(c);
    });
  }

  async function respond(c, serverId, action, text, replied = false) {
    const id = c.ids.get(serverId), item = routes.get(id);
    if (c.dead || !item || item.consumed) return;
    // Opening the inline editor is not an answer. NotificationReplied carries the actual text.
    if (action === "inline-reply") action = "reply";
    if (action === "reply" && item.reply && !replied) return;
    // Spend the answer before any effect or await, retaining the withdrawal handle for settlement.
    item.consumed = true;
    c.operations += 1;
    const openCard = () => { try { open(item.route, item.home); } catch { report("open failed"); } };
    try {
      if (action === "mute") {
        try { mute(item.route, item.home); } catch { report("mute failed"); }
      } else if (action === "allow" || action === "deny" || (action === "reply" && item.reply)) {
        let result;
        try { result = await act(item.token, action, action === "reply" ? text : undefined); }
        catch { report("answer failed"); }
        if (result?.ok !== true) openCard();
      } else {
        openCard(); // Includes default, open, and unknown actions: never infer permission.
      }
    } finally {
      if (forget(id)) await withdraw(c, serverId);
      c.operations -= 1;
      releaseIfIdle(c);
    }
  }

  function connect() {
    if (connection) return connection;
    const c = { bus: null, iface: null, ready: null, ids: new Map(), listeners: [], pending: 0, operations: 0, dead: false, reply: false, markup: false, names: null, watch: null, owner: null };
    connection = c; // Publish before loading: concurrent shows share even an unfinished connection.
    c.ready = (async () => {
      try {
        c.bus = loadBus();
        if (!c.bus || !["getProxyObject", "disconnect", "on"].every(name => typeof c.bus[name] === "function")) throw new Error("bus");
        const lost = () => { if (!c.dead) { report("connection ended"); disconnect(c); } };
        c.bus.on("error", lost);
        c.bus.on("end", lost);
        // Qualification belongs to ONE daemon: the unique owner of the service name while it was read. The watch is in place before
        // the owner is read, so a daemon that restarts or is replaced at any later moment ends this connection: its capabilities, its
        // markup and reply assumptions and its notification ids are never carried over to the daemon that took the name.
        c.names = (await c.bus.getProxyObject(BUS, BUS_PATH)).getInterface(BUS);
        if (c.dead || disposed) return false;
        c.watch = (name, _previous, owner) => {
          if (name !== SERVICE || c.dead || (c.owner !== null && owner === c.owner)) return;
          report("notification server replaced");
          disconnect(c);
        };
        c.names.on("NameOwnerChanged", c.watch);
        const owner = await c.names.GetNameOwner(SERVICE);
        if (c.dead || disposed || typeof owner !== "string" || !owner.startsWith(":")) return false;
        c.owner = owner;
        // Every later call (capabilities, server information, Notify, CloseNotification) and every signal goes through the unique
        // owner, never the well-known name: a daemon that takes the name while a post is on its way is not the one that was qualified.
        const proxy = await c.bus.getProxyObject(c.owner, PATH);
        if (c.dead || disposed) return false;
        c.iface = proxy.getInterface(SERVICE);
        if (!c.iface || !["GetCapabilities", "GetServerInformation", "Notify", "CloseNotification", "on", "removeListener"].every(name => typeof c.iface[name] === "function")) throw new Error("interface");
        const caps = await c.iface.GetCapabilities();
        // "body" is required with "actions": the executable detail lives in the body, and a summary-only server would not show it.
        if (c.dead || disposed || !Array.isArray(caps) || !caps.includes("actions") || !caps.includes("body")) return false;
        // Actions answer only on a server whose rendering was qualified; every other name (or none) leaves the card Open only.
        const info = await c.iface.GetServerInformation();
        if (c.dead || disposed || !Array.isArray(info) || !QUALIFIED_SERVERS.includes(info[0])) return false;
        // The daemon that answered both reads must still be the one that owned the name before them.
        if (await c.names.GetNameOwner(SERVICE) !== c.owner || c.dead || disposed) return false;
        c.reply = caps.includes("inline-reply");
        c.markup = caps.includes("body-markup");
        c.listeners = [
          ["ActionInvoked", (id, action) => { void respond(c, id, action); }],
          ["NotificationReplied", (id, text) => { void respond(c, id, "reply", text, true); }],
          ["NotificationClosed", id => {
            forget(c.ids.get(id));
            releaseIfIdle(c);
          }],
        ];
        for (const [name, listener] of c.listeners) c.iface.on(name, listener);
        return true;
      } catch { report("connection unavailable"); return false; }
    })();
    return c;
  }

  function close(ids) {
    for (const id of ids ?? []) {
      const item = forget(id);
      if (item) void withdraw(item.connection, item.serverId);
    }
  }

  return {
    available,
    async show({ entry, record, actionsOn, silent = false, plain: _plain, transport, identity, cancelled = () => false }) {
      const display = record?.display;
      const stopped = () => { try { return cancelled() === true; } catch { return true; } };
      if (stopped() || !available() || actionsOn !== true || record?.outsideOk?.[SURFACE] !== true ||
          typeof record.digest !== "string" || record.digest.length === 0 ||
          !display || ![display.botName, display.title, display.willRun].every(value => typeof value === "string" && value.length > 0) ||
          !entry?.frame || UNCARRIABLE.test(display.willRun) ||
          // The server names the exact pending card (approvalId, requestRef, actionHash). Without all three, or with a frame that names
          // another card, there is nothing safe to bind an answer to.
          !BINDING.every(name => typeof record[name] === "string" && record[name].length > 0 &&
            (entry.frame[name] === undefined || entry.frame[name] === record[name])) || routes.size + (connection?.pending ?? 0) >= MAX_ROUTES) return null;
      const c = connect();
      c.pending += 1;
      try {
        if (!await c.ready || c.dead || disposed || stopped()) return null; // a card that settled while the bus came up mints and posts nothing
        const body = bannerBody(display.willRun, c.markup);
        if (body === null) return null;
        const id = `mb:${randomBytes(8).toString("hex")}`;
        const bound = { ...entry, frame: { ...entry.frame, approvalId: record.approvalId, requestRef: record.requestRef, actionHash: record.actionHash } };
        let token;
        // The transport and identity captured with the card read travel with the mint: a later lookup could bind this banner to a replacement server.
        try { token = mint({ entry: bound, surface: SURFACE, surfaceId: id, digest: record.digest, transport, identity }); } catch { report("token unavailable"); }
        if (typeof token !== "string" || token.length === 0) return null;
        const tag = language(), labels = nativeBannerLabels(tag), openWord = openLabel(tag);
        // "default" is the body click. Reply uses the protocol's inline-reply key, so the server shows its own text field.
        const actions = ["default", openWord, "allow", labels.allow, "deny", labels.deny];
        if (c.reply) actions.push("inline-reply", labels.reply);
        actions.push("open", openWord);
        const hint = c.bus.notificationVariant ?? ((signature, value) => ({ signature, value }));
        const hints = silent === true ? { "suppress-sound": hint("b", true) } : {};
        const serverId = await c.iface.Notify("Murage", 0, "", `${display.botName}: ${display.title}`, body, actions, hints, -1);
        if (!Number.isInteger(serverId) || serverId <= 0 || serverId > 0xffffffff) return null;
        if (c.dead || disposed || stopped()) { await withdraw(c, serverId); return null; }
        if (c.ids.has(serverId)) { close([c.ids.get(serverId)]); return null; }
        const route = { botId: entry.frame.botId, threadId: entry.frame.threadId, messageId: entry.frame.messageId };
        routes.set(id, { connection: c, serverId, token, route, home: entry.home, reply: c.reply, consumed: false });
        c.ids.set(serverId, id);
        return [id];
      } catch { report("post failed"); return null; }
      finally { c.pending -= 1; releaseIfIdle(c); }
    },
    close,
    size: () => routes.size,
    dispose() {
      disposed = true;
      close([...routes.keys()]);
      if (connection) releaseIfIdle(connection);
    },
  };
}
