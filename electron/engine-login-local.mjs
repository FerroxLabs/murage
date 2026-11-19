import { withHideInherit } from "../shared/win-hide-child-process.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engine sign-in on this computer (1.0.14, design ENGINE-SIGNIN-SIMPLE-1014.md). Runs in Electron MAIN only.
// The rule: no sign-in output enters Murage. The server hands a fixed recipe; main starts the engine's own login with all
// three stdio on ignore; the engine opens the owner's browser and stores its own token; the probe says when it is done.
//   - Opening the dialog starts nothing. preview reads the engine and folder; only the press inside the dialog calls start.
//   - A session is registered before any await, starts are refused during quit, and the owned tree is ended and awaited
//     on stop, window destroy, timeout and quit.
//   - Natural child exit plus a re-probe decides the result. A probe never ends a child, with one exception: a change from
//     signed out to signed in shows Finishing and gives the child 30 seconds to leave by itself.
//   - A session that started signed in ignores the flag, because a stale login reads true. It ends only on child exit, and
//     Signed in then needs one real reply to pass.
import { randomUUID } from "node:crypto";

export const LOCAL_ENGINE_LOGIN_CHANNELS = Object.freeze({
  preview: "local-engine-login:preview",
  start: "local-engine-login:start",
  stop: "local-engine-login:stop",
  openTerminal: "local-engine-login:open-terminal",
  data: "local-engine-login:data", // main -> renderer
  closed: "local-engine-login:closed", // main -> renderer
});

export const LOCAL_ENGINE_LOGIN_LIMITS = Object.freeze({ totalMs: 900_000, probeMs: 5_000, finishMs: 30_000, killGraceMs: 3_000, killForceMs: 1_000, supervisorPollMs: 2_000 });

export const LOCAL_COPY = Object.freeze({
  badRequest: "That sign-in request isn't valid.",
  busy: "Another sign-in is already open. Finish or close it first.",
  closing: "Murage is closing.",
  notOpen: "That sign-in isn't open any more.",
  noTerminal: "Finish in your terminal.",
  terminalFailed: "The terminal didn't open.",
  startFailed: "This engine's sign-in didn't start.",
  unreachable: "Murage isn't ready yet. Try again in a moment.",
});

const validRecipe = (recipe) => Boolean(recipe) && ["headless", "terminal", "none"].includes(recipe.kind) && Array.isArray(recipe.argv) && recipe.argv.every((part) => typeof part === "string")
  && recipe.env && typeof recipe.env === "object";

const newSession = (id, instanceId, sender, kind) => ({ id, instanceId, sender, recipe: null, kind, child: null, supervisor: null, launching: null, started: false, over: false,
  exited: false, exitCode: null, startedSignedIn: null, flipped: false, probing: false, onExit: [], ending: null, totalTimer: null, watchTimer: null, settleTimer: null, message: null });

/**
 * @param deps.api (path, body?, options?) => Promise<{ status: number, body: any }>: the local server with the desktop's proof.
 * @param deps.spawn node's spawn. @param deps.killTree (child, signal) => void: the child's whole owned tree.
 * @param deps.launchTerminal (recipe) => Promise<{ ok, supervisor?, code? }>.
 */
export function createLocalEngineLogin({ api, spawn, killTree, launchTerminal, timers = globalThis, log = () => {}, limits: overrides = {}, newId = randomUUID }) {
  if (typeof api !== "function" || typeof spawn !== "function" || typeof killTree !== "function") throw new TypeError("api, spawn and killTree are required");
  const limits = { ...LOCAL_ENGINE_LOGIN_LIMITS, ...overrides };
  const sendTo = (sender, channel, payload) => { try { if (sender && !sender.isDestroyed?.()) sender.send(channel, payload); } catch { /* window gone */ } };
  let active = null;
  let quitting = false;

  async function readRecipe(instanceId) {
    try {
      const reply = await api("/api/engine-signin-recipe", { instanceId });
      if (reply.status === 200 && validRecipe(reply.body)) return { recipe: reply.body };
      return { code: reply.status === 404 ? "not-found" : "unreachable" };
    } catch { return { code: "unreachable" }; }
  }

  /** That one instance's `authenticated`: true, false, or null when the probe could not answer. */
  async function probe(instanceId) {
    try {
      const reply = await api("/api/engine-signin-probe", { instanceId });
      return reply.status === 200 && typeof reply.body?.authenticated === "boolean" ? reply.body.authenticated : null;
    } catch { return null; }
  }

  /** The sign-in finished: tell the server, so a rejection from before it stops marking this engine signed out. */
  async function confirmSignedIn(session) {
    try { await api("/api/engine-signin-probe", { instanceId: session.instanceId, signedIn: true }); } catch { /* the mark ends by itself */ }
  }

  /** One short real reply through the engine, for a session that started signed in. Only ever after that session's child left. */
  async function realReply(session) {
    try {
      const reply = await api("/api/engine-setup-check", { instanceId: session.instanceId }, { timeoutMs: 120_000 });
      if (reply.status !== 200) return false;
      if (typeof reply.body?.line === "string" && reply.body.result !== "ready") session.message = reply.body.line;
      return reply.body?.result === "ready";
    } catch { return false; }
  }

  function endChild(session) {
    const child = session.child;
    if (!child || session.exited) return Promise.resolve();
    return new Promise((resolve) => {
      let force = null, last = null;
      const finished = () => { if (force) timers.clearTimeout(force); if (last) timers.clearTimeout(last); resolve(); };
      session.onExit.push(finished);
      try { killTree(child, "SIGTERM"); } catch { /* gone */ }
      force = timers.setTimeout(() => {
        try { killTree(child, "SIGKILL"); } catch { /* gone */ }
        last = timers.setTimeout(finished, limits.killForceMs);
      }, limits.killGraceMs);
    });
  }

  /** The word for the end of a session. stopped, handoff and failed were decided by the caller. */
  async function resultOf(session, outcome) {
    if (outcome === "stopped" || outcome === "handoff") return "stopped";
    if (outcome === "failed") return "failed";
    if (quitting) return "not-finished";
    const signedIn = await probe(session.instanceId);
    // Two probe readings alone prove nothing: a first reading that timed out says false, and a stale login then reads true. A login
    // CLI that left by itself with 0 said it finished. Anything else that looks like a change has to pass the one real reply.
    const changed = session.startedSignedIn === false && (session.flipped || signedIn === true);
    const leftClean = outcome === "exited" && session.child !== null && session.exitCode === 0;
    if (changed && leftClean && signedIn === true) { await confirmSignedIn(session); return "signed-in"; }
    if (changed) return await realReply(session) ? "signed-in" : "not-finished";
    if (outcome === "timeout") return "not-finished";
    // A child that left for any other reason (a port taken, a page closed) is Not finished, and Terminal stays a choice.
    const cleanExit = session.child === null || session.exitCode === 0;
    // An engine that cannot say (null) is not signed out: the real reply decides, as it does for a login that may be stale.
    return signedIn !== false && cleanExit && await realReply(session) ? "signed-in" : "not-finished";
  }

  /** The one way out: end what runs, wait for a launch still on its way, settle the word, tell the window. */
  function finish(session, outcome) {
    if (session.ending) return session.ending;
    session.ending = (async () => {
      session.over = true;
      for (const timer of [session.totalTimer, session.settleTimer]) if (timer) timers.clearTimeout(timer);
      if (session.watchTimer) timers.clearInterval(session.watchTimer);
      await endChild(session);
      if (session.launching) { try { await session.launching; } catch { /* reported at the launch */ } }
      if (session.supervisor && outcome !== "exited") { try { await session.supervisor.stop(); } catch { /* gone */ } }
      const result = await resultOf(session, outcome);
      if (active === session) active = null;
      log(`engine-signin end kind=${session.kind ?? "none"} result=${result}`);
      // A hand-off to Terminal carries on in the same dialog, so nothing closes there.
      if (session.started && outcome !== "handoff") sendTo(session.sender, LOCAL_ENGINE_LOGIN_CHANNELS.closed, { id: session.id, result, ...(session.message ? { message: session.message } : {}) });
      return result;
    })();
    return session.ending;
  }

  /** Progress only. A change from signed out to signed in shows Finishing; every other reading changes nothing. */
  async function watch(session) {
    if (session.over || session.flipped || session.probing || session.startedSignedIn !== false) return;
    session.probing = true;
    const signedIn = await probe(session.instanceId);
    session.probing = false;
    if (session.over || signedIn !== true) return;
    session.flipped = true;
    if (session.watchTimer) { timers.clearInterval(session.watchTimer); session.watchTimer = null; }
    sendTo(session.sender, LOCAL_ENGINE_LOGIN_CHANNELS.data, { id: session.id, finishing: true });
    session.settleTimer = timers.setTimeout(() => { void finish(session, "settled"); }, limits.finishMs);
  }

  function spawnChild(session) {
    const { recipe } = session;
    let child;
    // The recipe's env is the whole environment: nothing of this process passes. The names it left out are named again as a belt.
    const env = { ...recipe.env };
    for (const name of recipe.unsetKeys ?? []) delete env[name];
    try { child = spawn(recipe.argv[0], [...recipe.argv.slice(1)], withHideInherit({ env, stdio: ["ignore", "ignore", "ignore"], windowsHide: true, shell: false, detached: process.platform !== "win32" })); }
    catch { return false; }
    session.child = child;
    child.once("error", () => { session.exited = true; for (const done of session.onExit.splice(0)) done(); void finish(session, "failed"); });
    child.once("close", (code) => {
      session.exited = true; session.exitCode = code;
      for (const done of session.onExit.splice(0)) done();
      void finish(session, "exited");
    });
    return true;
  }

  /** What the dialog names before anything starts. Starts nothing, holds nothing, and carries no argv or env to a window. */
  async function preview({ instanceId }) {
    if (typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > 180) return { ok: false, code: "bad-request", message: LOCAL_COPY.badRequest };
    const { recipe, code } = await readRecipe(instanceId);
    if (!recipe) return { ok: false, code, message: LOCAL_COPY.unreachable };
    return { ok: true, kind: recipe.kind, label: typeof recipe.label === "string" ? recipe.label : "", accountRoot: typeof recipe.accountRoot === "string" ? recipe.accountRoot : "" };
  }

  /** The press inside the dialog. @returns {{ ok: true, id } | { ok: false, code, message }} */
  async function start({ sender, instanceId }) {
    if (!sender || typeof sender.send !== "function" || typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > 180) return { ok: false, code: "bad-request", message: LOCAL_COPY.badRequest };
    if (quitting) return { ok: false, code: "closing", message: LOCAL_COPY.closing };
    if (active) return { ok: false, code: "busy", message: LOCAL_COPY.busy };
    // Registered before any await: a second start, a stop or a quit sees this at once.
    const session = newSession(newId(), instanceId, sender, "headless");
    active = session;
    sender.once?.("destroyed", () => { if (!session.over) void finish(session, "stopped"); });
    const refuse = async (code, message) => { await finish(session, "failed"); return { ok: false, code, message }; };
    const { recipe, code } = await readRecipe(instanceId);
    if (!recipe) return refuse(code, LOCAL_COPY.unreachable);
    if (session.over) return refuse("not-open", LOCAL_COPY.notOpen);
    if (recipe.kind !== "headless") return refuse("start-failed", LOCAL_COPY.startFailed);
    session.recipe = recipe;
    session.startedSignedIn = await probe(instanceId);
    if (session.over) return refuse("not-open", LOCAL_COPY.notOpen);
    if (!spawnChild(session)) return refuse("start-failed", LOCAL_COPY.startFailed);
    session.started = true;
    session.totalTimer = timers.setTimeout(() => { void finish(session, "timeout"); }, limits.totalMs);
    session.watchTimer = timers.setInterval(() => { void watch(session); }, limits.probeMs);
    log("engine-signin start kind=headless");
    return { ok: true, id: session.id };
  }

  async function stop({ sender, id }) {
    const session = active && !active.over && active.id === id && active.sender === sender ? active : null;
    if (!session) return { ok: false, code: "not-open", message: LOCAL_COPY.notOpen };
    await finish(session, "stopped");
    return { ok: true };
  }

  /** Terminal, for the same engine: a running sign-in is stopped and awaited first, so Codex cannot meet its own listener on 1455.
   * An ended sign-in holds nothing, so that path starts clean. */
  async function runTerminal({ sender, instanceId }) {
    if (quitting) return { ok: false, code: "closing", message: LOCAL_COPY.closing };
    if (typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > 180) return { ok: false, code: "bad-request", message: LOCAL_COPY.badRequest };
    if (active) {
      const same = active.instanceId === instanceId && active.child && (!sender || active.sender === sender);
      if (!same) return { ok: false, code: "busy", message: LOCAL_COPY.busy };
      await finish(active, "handoff");
    }
    if (active || quitting) return { ok: false, code: "busy", message: LOCAL_COPY.busy };
    const session = newSession(newId(), instanceId, sender, "terminal");
    active = session;
    sender?.once?.("destroyed", () => { if (!session.over) void finish(session, "stopped"); });
    const { recipe } = await readRecipe(instanceId);
    if (!recipe || recipe.argv.length === 0 || recipe.kind === "none") { await finish(session, "failed"); return { ok: false, code: "terminal-failed", message: LOCAL_COPY.terminalFailed }; }
    session.recipe = recipe;
    session.startedSignedIn = await probe(instanceId);
    if (session.over) { await session.ending; return { ok: false, code: "not-open", message: LOCAL_COPY.notOpen }; }
    // Quit and Cancel await this launch through finish, then stop what it opened.
    session.launching = (async () => launchTerminal(recipe))().catch(() => ({ ok: false, code: "failed" }));
    const launched = await session.launching;
    session.launching = null;
    if (launched?.ok) session.supervisor = launched.supervisor;
    if (!launched?.ok) {
      await finish(session, "failed");
      return launched?.code === "no-terminal" ? { ok: false, code: "no-terminal", message: LOCAL_COPY.noTerminal } : { ok: false, code: "terminal-failed", message: LOCAL_COPY.terminalFailed };
    }
    if (session.over) {
      // Quit during the launch: finish has stopped what opened.
      await session.ending;
      return { ok: false, code: "not-open", message: LOCAL_COPY.notOpen };
    }
    session.started = true;
    session.totalTimer = timers.setTimeout(() => { void finish(session, "timeout"); }, limits.totalMs);
    session.watchTimer = timers.setInterval(() => { if (!launched.supervisor.alive()) void finish(session, "exited"); }, limits.supervisorPollMs);
    return { ok: true, id: session.id };
  }

  const openTerminal = ({ sender, instanceId }) => sender ? runTerminal({ sender, instanceId }) : Promise.resolve({ ok: false, code: "bad-request", message: LOCAL_COPY.badRequest });

  /** engine:open-setup-terminal's sign-in path: runs the recipe by instance id. True only for a window the owner can see. */
  async function openRecipeTerminal({ instanceId }) {
    return (await runTerminal({ sender: null, instanceId })).ok === true;
  }

  /** Quit: refuse new starts, end what is open, and wait for it. */
  async function shutdown() {
    quitting = true;
    if (active) await finish(active, "stopped");
  }

  return { preview, start, stop, openTerminal, openRecipeTerminal, shutdown, isOpen: () => Boolean(active) };
}

/** Registers the channels through the owned-main gate, main frame only. Each handler takes only what the bridge names. */
export function registerLocalEngineLoginIpc({ ipcMain, runner }) {
  const str = (value, max = 200) => typeof value === "string" && value.length <= max ? value : "";
  const bad = { ok: false, code: "bad-request", message: LOCAL_COPY.badRequest };
  const mainFrame = (event) => !event.senderFrame || event.senderFrame === event.sender.mainFrame;
  const handle = (channel, fn) => ipcMain.handle(channel, (event, request) => mainFrame(event) && request && typeof request === "object" ? fn(event, request) : bad);
  handle(LOCAL_ENGINE_LOGIN_CHANNELS.preview, (_event, request) => runner.preview({ instanceId: str(request.instanceId, 180) }));
  handle(LOCAL_ENGINE_LOGIN_CHANNELS.start, (event, request) => runner.start({ sender: event.sender, instanceId: str(request.instanceId, 180) }));
  handle(LOCAL_ENGINE_LOGIN_CHANNELS.stop, (event, request) => runner.stop({ sender: event.sender, id: str(request.id) }));
  handle(LOCAL_ENGINE_LOGIN_CHANNELS.openTerminal, (event, request) => runner.openTerminal({ sender: event.sender, instanceId: str(request.instanceId, 180) }));
}
