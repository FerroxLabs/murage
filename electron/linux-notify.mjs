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
const MAX_ROUTES = 1024;

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
    const c = { bus: null, iface: null, ready: null, ids: new Map(), listeners: [], pending: 0, operations: 0, dead: false, reply: false };
    connection = c; // Publish before loading: concurrent shows share even an unfinished connection.
    c.ready = (async () => {
      try {
        c.bus = loadBus();
        if (!c.bus || !["getProxyObject", "disconnect", "on"].every(name => typeof c.bus[name] === "function")) throw new Error("bus");
        const lost = () => { if (!c.dead) { report("connection ended"); disconnect(c); } };
        c.bus.on("error", lost);
        c.bus.on("end", lost);
        const proxy = await c.bus.getProxyObject(SERVICE, PATH);
        if (c.dead || disposed) return false;
        c.iface = proxy.getInterface(SERVICE);
        if (!c.iface || !["GetCapabilities", "Notify", "CloseNotification", "on", "removeListener"].every(name => typeof c.iface[name] === "function")) throw new Error("interface");
        const caps = await c.iface.GetCapabilities();
        if (c.dead || disposed || !Array.isArray(caps) || !caps.includes("actions")) return false;
        c.reply = caps.includes("inline-reply");
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
    async show({ entry, record, actionsOn, silent = false, plain: _plain }) {
      const display = record?.display;
      if (!available() || actionsOn !== true || record?.outsideOk?.[SURFACE] !== true ||
          typeof record.digest !== "string" || record.digest.length === 0 ||
          !display || ![display.botName, display.title, display.willRun].every(value => typeof value === "string" && value.length > 0) ||
          !entry?.frame || routes.size + (connection?.pending ?? 0) >= MAX_ROUTES) return null;
      const c = connect();
      c.pending += 1;
      try {
        if (!await c.ready || c.dead || disposed) return null;
        const id = `mb:${randomBytes(8).toString("hex")}`;
        let token;
        try { token = mint({ entry, surface: SURFACE, surfaceId: id, digest: record.digest }); } catch { report("token unavailable"); }
        if (typeof token !== "string" || token.length === 0) return null;
        const labels = nativeBannerLabels(language());
        const actions = ["allow", labels.allow, "deny", labels.deny];
        if (c.reply) actions.push("reply", labels.reply);
        const hint = c.bus.notificationVariant ?? ((signature, value) => ({ signature, value }));
        const hints = silent === true ? { "suppress-sound": hint("b", true) } : {};
        const serverId = await c.iface.Notify("Murage", 0, "", `${display.botName}: ${display.title}`, display.willRun, actions, hints, -1);
        if (!Number.isInteger(serverId) || serverId <= 0 || serverId > 0xffffffff) return null;
        if (c.dead || disposed) { await withdraw(c, serverId); return null; }
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
