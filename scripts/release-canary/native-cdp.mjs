// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { memoryState, turnWitness } from "./native-evidence.mjs";

export async function until(ms, reason, read) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const result = await read();
    if (result && performance.now() < end) return result;
    await pause(500);
  }
  throw Error(reason);
}

export async function connectRenderer(port, verifyListener, startupMs, onWait) {
  const origin = `http://127.0.0.1:${port}`;
  const { socketUrl, appOrigin } = await until(startupMs, "CDP_UNAVAILABLE", async () => {
    await onWait();
    if (!await verifyListener()) return null;
    const response = await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (!response?.ok) return null;
    const targets = (await response.json()).filter(target => target.type === "page" &&
      /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url));
    if (!targets.length) return null;
    if (targets.length !== 1) throw Error("CDP_TARGET");
    const socketUrl = new URL(targets[0].webSocketDebuggerUrl);
    if (socketUrl.origin !== `ws://127.0.0.1:${port}` || !/^\/devtools\/page\/[-\w]+$/.test(socketUrl.pathname)) {
      throw Error("CDP_TARGET");
    }
    return { socketUrl, appOrigin: new URL(targets[0].url).origin };
  });

  const ws = new WebSocket(socketUrl);
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const { id, error, result } = JSON.parse(data);
    const complete = pending.get(id);
    if (complete) complete(error, result);
  });
  const ready = new Promise(resolve => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    ws.addEventListener("error", () => resolve(false), { once: true });
  });
  try {
    if (!await Promise.race([ready, pause(4000, false, { ref: false })])) throw Error("CDP_UNAVAILABLE");
  } catch (error) {
    ws.close();
    throw error;
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const finish = (error, result) => {
      clearTimeout(timer);
      pending.delete(id);
      if (error) reject(Error("CDP_CALL"));
      else resolve(result);
    };
    const timer = setTimeout(() => finish(true), 10000);
    pending.set(id, finish);
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch { finish(true); }
  });
  const evaluate = async (fn, ...args) => {
    const { result, exceptionDetails } = await call("Runtime.evaluate", {
      expression: `location.origin === ${JSON.stringify(appOrigin)} ? (${fn})(...${JSON.stringify(args)}) : null`,
      awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw Error("CDP_EVALUATE");
    return result.value;
  };
  return { call, evaluate, close: () => ws.close() };
}

export async function click(renderer, selector, { label, focus = false, optional = false } = {}) {
  const acted = await renderer.evaluate((selector, label, focus) => {
    const nodes = [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length);
    if (nodes.length !== 1 || nodes[0].disabled || (label && nodes[0].textContent.trim() !== label)) return false;
    if (focus) {
      if (nodes[0].value || nodes[0].isContentEditable && nodes[0].textContent.trim()) return false;
      nodes[0].focus();
      return document.activeElement === nodes[0];
    }
    // Return the CDP reply before an updater action can close this renderer.
    setTimeout(() => { if (nodes[0].isConnected && !nodes[0].disabled) nodes[0].click(); }, 0);
    return true;
  }, selector, label, focus);
  if (!acted && !optional) throw Error("UI_CONTROL");
  return acted;
}

export async function clearOfPrompts(renderer) {
  const clear = await renderer.evaluate(() => {
    const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
    const prompts = document.querySelectorAll("[data-approval-queue], [data-approval-waiting], [role=alertdialog]");
    const restricted = /^(sign in|sign in again|accept|i agree|allow once|always allow|approve|grant permission|continue setup|start setup)$/i;
    return ![...prompts].some(visible) &&
      ![...document.querySelectorAll("button, [role=button]")].some(node =>
        visible(node) && restricted.test((node.getAttribute("aria-label") || node.textContent).trim()));
  });
  if (clear !== true) throw Error("NEVER_LIST_BLOCKED");
}

export function readMemory(renderer) {
  return renderer.evaluate(async () => {
    const response = await fetch("/api/health", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: response.ok ? await response.json() : null };
  }).then(answer => answer ? memoryState(answer) : "UNKNOWN");
}

export async function runTurn(renderer, onWait, onThread) {
  const token = `CANARY-${randomBytes(6).toString("hex")}-C`;
  const prompt = `Reply with exactly this token and nothing else: ${token}`;
  const selectedThread = () => renderer.evaluate(async () => {
    const secret = window.muragebox?.desktopSurfaceSecret;
    if (typeof secret !== "string" || !secret) return null;
    const response = await fetch("/api/bots?view=sidebar", {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret },
    });
    if (!response.ok) return null;
    const bots = (await response.json()).bots.filter(bot => bot.name === "Canary");
    return bots.length === 1 ? bots[0].threadId : null;
  });
  const previous = await until(20000, "PROFILE_STALE", async () => {
    await onWait();
    await clearOfPrompts(renderer);
    return selectedThread();
  });
  const composer = '[data-testid="chat-column"] textarea[aria-label="Message Canary"]';
  await until(15000, "PROFILE_STALE", () => renderer.evaluate(selector =>
    Boolean(document.querySelector(selector)?.getClientRects().length), composer));
  await clearOfPrompts(renderer);
  await click(renderer, '[data-testid="chat-column"] button[aria-label="New chat"]');
  const thread = await until(15000, "NEW_THREAD", async () => {
    const current = await selectedThread();
    return current !== previous && /^[-\w]+$/.test(current ?? "") ? current : null;
  });
  onThread(thread);
  await clearOfPrompts(renderer);
  await click(renderer, composer, { focus: true });
  await renderer.call("Input.insertText", { text: prompt });
  if (!await renderer.evaluate((selector, text) => document.querySelector(selector)?.value === text, composer, prompt)) {
    throw Error("CDP_INPUT");
  }
  await clearOfPrompts(renderer);
  await click(renderer, '[data-testid="chat-column"] button[aria-label="Send message"]');
  const reply = await until(240000, "TURN_TIMEOUT", async () => {
    await onWait();
    await clearOfPrompts(renderer);
    const rows = await renderer.evaluate(async (id, prompt) => {
      const get = async endpoint => {
        const response = await fetch(`/api/threads/${id}/${endpoint}`, {
          cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
          headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": window.muragebox.desktopSurfaceSecret },
        });
        return response.ok ? response.json() : null;
      };
      const transcript = await get("messages?limit=40");
      if (!transcript?.messages?.some(row => row.role === "user" && row.text === prompt)) return null;
      const log = await get("events?limit=100");
      return {
        messages: transcript.messages.map(({ id, role, kind, actorKind, text, turnId }) =>
          ({ id, role, kind, actorKind, text, turnId })),
        events: (log?.entries ?? []).filter(entry => entry.kind === "runtime")
          .map(({ data: { type, turnId, ok, stopReason } }) => ({ type, turnId, ok, stopReason: Boolean(stopReason) })),
      };
    }, thread, prompt);
    if (!rows) return null;
    if (rows.events.some(event => event.type === "request.opened")) throw Error("NEVER_LIST_BLOCKED");
    if (rows.events.some(event => event.type === "turn.completed" && (event.ok === false || event.stopReason))) {
      throw Error("TURN_ERROR");
    }
    const message = turnWitness(rows.messages, rows.events, token);
    if (!message) return null;
    return await renderer.evaluate((id, token) => {
      const bubble = document.querySelector(`[data-mid="${CSS.escape(id)}"] [data-testid="msg-bubble"]`);
      return Boolean(bubble?.getClientRects().length && bubble.innerText.trim() === token);
    }, message, token);
  });
  return { terminal: reply, token_check: true, renderer_agrees: true };
}

export async function screenshot(renderer) {
  const { data } = await renderer.call("Page.captureScreenshot", { format: "png", fromSurface: true });
  if (!await renderer.evaluate(async data => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    if (bitmap.width < 100 || bitmap.height < 100) return false;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, 64, 64);
    const rgba = ctx.getImageData(0, 0, 64, 64).data;
    for (let n = 4; n < rgba.length; n += 4) {
      if (rgba[n + 3] && [0, 1, 2].some(c => Math.abs(rgba[n + c] - rgba[c]) >= 16)) return true;
    }
    return false;
  }, data)) throw Error("SCREENSHOT_BLANK");
  return Buffer.from(data, "base64");
}

export async function updaterState(renderer) {
  return renderer.evaluate(() => new Promise(resolve => {
    const updater = window.muragebox?.updater;
    if (!updater) return resolve(null);
    const timer = setTimeout(() => { dispose(); resolve(null); }, 2000);
    const dispose = updater.onState(value => {
      clearTimeout(timer);
      dispose();
      resolve({
        status: value?.status, version: value?.version, currentVersion: value?.currentVersion,
        tlsError: /CERT_|certificate|\bSSL\b/i.test(value?.message ?? ""),
      });
    });
  }));
}
