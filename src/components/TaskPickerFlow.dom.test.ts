// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { cleanup, installDOMHarness, mount } from "../testing/dom-harness";
import { StoreProvider, useStore, type Bot } from "../state/store";
import { TaskPicker } from "./TaskPicker";

let fixture: VerificationServer;
let restore: () => void;
const transport = globalThis.fetch;
beforeAll(async () => {
  restore = installDOMHarness();
  fixture = await launchVerificationServer(process.env);
}, 120_000);
afterAll(async () => { await fixture?.close(); restore?.(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const until = async (check: () => boolean) => {
  const end = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > end) throw Error("Chat fixture did not settle");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  }
};

it.each(["next", "previous"])("deleting the open chat selects the %s visible row through the picker, dispatch, HTTP and store", async direction => {
  const proof = await (await transport(new URL("/api/desktop-secret", fixture.info.url))).json();
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await transport(new URL(path, fixture.info.url), {
      method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return await response.json();
  };
  const created = (await request("POST", "/api/bots", { name: "Chat fixture" })).bot;
  const first = created.threadId;
  await request("PATCH", `/api/bots/${created.id}/tasks/${first}`, { title: "Visible first" });
  const second = (await request("POST", `/api/bots/${created.id}/tasks`, { title: "Visible second" })).task.threadId;
  const hidden = (await request("POST", `/api/bots/${created.id}/tasks`, { title: "[Delegated by @Fixture] Hidden work" })).task.threadId;
  const open = direction === "next" ? second : first;
  const expected = direction === "next" ? first : second;
  await request("POST", `/api/bots/${created.id}/tasks/${open}`);

  // Adapt the browser transport only. The actual server streams its switch frame
  // and the actual StoreProvider admits both that frame and the DELETE answer.
  const sources: BrowserEvents[] = [];
  const frames: any[] = [];
  class BrowserEvents {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
    controller = new AbortController();
    constructor(url: string) { sources.push(this); void this.read(url); }
    async read(url: string) {
      try {
        const response = await transport(new URL(url, fixture.info.url), { signal: this.controller.signal });
        this.onopen?.();
        const reader = response.body!.getReader(), decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const id = block.split("\n").find(line => line.startsWith("id: "))?.slice(4) ?? "";
            for (const line of block.split("\n")) if (line.startsWith("data: ")) {
              const data = line.slice(6); frames.push(JSON.parse(data));
              this.onmessage?.({ data, lastEventId: id });
            }
          }
        }
      } catch (error) { if (!this.controller.signal.aborted) throw error; }
    }
    close() { this.controller.abort(); }
  }
  let current: Bot | undefined;
  const deletes: Array<{ url: string; status: number; body: any }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? new URL(input, fixture.info.url) : input;
    const response = await transport(url, init);
    if (init?.method === "DELETE") deletes.push({ url: String(url), status: response.status, body: await response.clone().json() });
    return response;
  });
  vi.stubGlobal("EventSource", BrowserEvents);
  function Surface() {
    current = useStore().state.bots.find(bot => bot.id === created.id);
    return current ? h(TaskPicker, { bot: current }) : null;
  }
  try {
    const view = mount(h(StoreProvider, null, h(Surface)));
    await until(() => current?.threadId === open && frames.some(frame => frame.kind === "caught-up"));
    expect(current!.tasks![0].threadId).toBe(hidden);
    act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="Chat list"]')!.click());
    const sort = view.container.querySelector<HTMLSelectElement>('[aria-label="Sort chats"]')!;
    act(() => { sort.value = "created"; sort.dispatchEvent(new Event("change", { bubbles: true })); });
    const filters = view.container.querySelector('[aria-label="Filter chats"]')!;
    act(() => Array.from(filters.querySelectorAll("button")).find(button => button.textContent === "Yours")!.click());
    const rows = Array.from(view.container.querySelectorAll<HTMLButtonElement>("[data-task-nav]"));
    expect(rows.map(row => row.textContent)).toEqual([expect.stringContaining("Visible second"), expect.stringContaining("Visible first")]);
    const active = rows.find(row => row.textContent?.includes(direction === "next" ? "Visible second" : "Visible first"))!;
    act(() => active.parentElement!.querySelector<HTMLButtonElement>('[aria-label="Delete chat"]')!.click());
    const confirm = view.container.querySelector('[aria-label^="Delete Visible"]')!;
    act(() => Array.from(confirm.querySelectorAll("button")).find(button => button.textContent === "Delete")!.click());
    await until(() => deletes.length === 1);
    expect(deletes[0].status).toBe(200);
    expect(deletes[0].body.bot.threadId).toBe(expected);
    expect(new URL(deletes[0].url).searchParams.get("nextThreadId")).toBe(expected);
    await until(() => current?.threadId === expected);
    expect(current!.tasks!.some(task => task.threadId === open)).toBe(false);
    const saved = (await request("GET", "/api/bots?messages=0")).bots.find((bot: Bot) => bot.id === created.id);
    expect(saved.threadId).toBe(expected);
    expect((await request("GET", `/api/deletion-preview?botId=${created.id}`)).messages).toBeGreaterThanOrEqual(0);
    console.log("CHAT_FLOW_EVIDENCE", JSON.stringify({ direction, open, hidden, expected, request: deletes[0].url, status: deletes[0].status, responseThread: deletes[0].body.bot.threadId, clientThread: current!.threadId, savedThread: saved.threadId }));
  } finally { cleanup(); sources.forEach(source => source.close()); }
}, 60_000);
