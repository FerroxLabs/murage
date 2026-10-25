// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 05-B1: a JavaScript dialog the page opens while a bot's browser call is in flight is answered, so the call can finish.
import { afterEach, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { BrowserDocumentGuard } from "./browser-document-guard.ts";

const servers: WebSocketServer[] = [];
const guards: BrowserDocumentGuard[] = [];
afterEach(() => { for (const g of guards.splice(0)) g.close(); for (const s of servers.splice(0)) s.close(); });

async function fakeBrowser() {
  const answers: Array<{ accept: unknown; sessionId: unknown }> = [];
  let peer: WebSocket | undefined;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), result }));
      switch (m.method) {
        case "Target.getTargets": return reply({ targetInfos: [{ targetId: "t1", type: "page" }] });
        case "Target.attachToTarget": return reply({ sessionId: "s1" });
        case "Page.getFrameTree": return reply({ frameTree: { frame: { id: "f1" } } });
        case "Page.createIsolatedWorld": return reply({ executionContextId: 7 });
        case "Runtime.evaluate": return reply({ result: { type: "boolean", value: false } });
        case "DOM.getDocument": return reply({ root: { children: [] } });
        case "Page.handleJavaScriptDialog": answers.push({ accept: m.params.accept, sessionId: m.sessionId }); return reply({});
        default: return reply({});
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  const guard = new BrowserDocumentGuard(async () => ({ cdpUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }));
  guards.push(guard);
  await guard.protected();
  const open = (type: string) => peer!.send(JSON.stringify({ method: "Page.javascriptDialogOpening", sessionId: "s1", params: { type, message: "hi" } }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  return { guard, answers, open, settle };
}

it("accepts an alert and a beforeunload, and dismisses a confirm and a prompt, while a call is in flight", async () => {
  const { guard, answers, open, settle } = await fakeBrowser();
  guard.answerDialogs(true);
  for (const type of ["alert", "beforeunload", "confirm", "prompt"]) { open(type); await settle(); }
  expect(answers).toEqual([
    { accept: true, sessionId: "s1" }, { accept: true, sessionId: "s1" },
    { accept: false, sessionId: "s1" }, { accept: false, sessionId: "s1" },
  ]);
});

it("leaves a dialog alone between calls, when the owner may be driving the page", async () => {
  const { guard, answers, open, settle } = await fakeBrowser();
  guard.answerDialogs(true); guard.answerDialogs(false);
  open("confirm"); await settle();
  expect(answers).toEqual([]);
});
