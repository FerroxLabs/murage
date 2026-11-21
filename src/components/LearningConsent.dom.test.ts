// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import baseRequest from "./fixtures/learning-request.e2aa9ce.json";

// MAIN 11:35Z (ownerfb race bar): the learning disclosure is Settings toggle text only; no chat surface shows the in-chat notice.
const oldNotice = "Murage learns from your chats using Flux.";
const settingsLine = "Memory learning uses Flux to pick out what to remember from your chats when you have a Flux key.";
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const learning = {
  revision: 1,
  settings: { version: 3, automaticFacts: true, automaticProcedures: true, reviewMode: false, perCallOutputTokens: { extraction: 2000, grounding: 64, reflection: 8000 }, ceiling: { input: 100_000_000, output: 15_000_000 }, callsPerMinute: 6, learnFrom: { chats: true, channels: true }, botsPaused: [] },
  connection: { instanceId: "@murage/flux-fast", source: "default", label: "Flux Router · Fast" }, defaultOn: true,
  ceiling: { month: "2026-11", input: 100_000_000, output: 15_000_000, inputUsed: 0, outputUsed: 0, paused: false },
};

async function fixture() {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const extraction = await import("../../server/memory/extract.ts");
  const { MemorySectionContent } = await import("./MemorySection");
  const { learningDefaultOnFor, resolveLearningConnection } = await import("../../server/memory/extractor-connections.ts");
  const { openLearningGate } = await import("../../server/testing/open-learning-gate.ts");
  const live = await import("../lib/live-events.ts");
  // The transport hook the store forwarded each learning frame to before MAIN 11:35Z; absent now, so a send reaches no chat surface.
  const frames = live as unknown as { receiveLearningNoticeFrame?: (frame: { kind: string; learningFluxSent?: unknown }) => void };
  const sends = vi.fn(() => frames.receiveLearningNoticeFrame?.({ kind: "learning.flux-sent" }));
  extraction.setLearningFluxSendListener(sends);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "[]" } }] })));
  vi.stubGlobal("fetch", fetcher);
  const connection = resolveLearningConnection({ selected: null, instances: [], readKey: () => "learning-fixture-key", defaultOn: learningDefaultOnFor(undefined, true) });
  expect(connection).toMatchObject({ source: "default", instanceId: "@murage/flux-fast", reviewOnly: false });
  const send = () => connection.extractor!("Owner prefers daily reports.", 100, new AbortController().signal, { fence: openLearningGate() } as never);
  const mount = async () => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(createElement(MemorySectionContent, {
      status: { mode: "active", learning, configuration: { extractorInstanceId: null }, extractors: [] },
      bots: [], events: [], cursor: null, filter: "", busy: false, historyBusy: false, refusals: {}, workspace: null,
      onAction: vi.fn(), onFilter: vi.fn(), onMore: vi.fn(), onOpen: vi.fn(), onRefresh: vi.fn(),
    } as never)));
  };
  return { send, mount, fetcher, sends };
}

it("LEARNING-CONSENT a Flux learning send shows no in-chat notice; the disclosure is the Settings toggle text", async () => {
  const f = await fixture();
  await f.mount();
  await act(async () => { await f.send(); });
  expect(f.sends).toHaveBeenCalledTimes(1);
  expect(host.querySelectorAll("[data-learning-notice]")).toHaveLength(0);
  expect(host.textContent).not.toContain(oldNotice);
  const how = host.querySelector('section[aria-label="How it learns"]');
  expect(how?.textContent).toContain(settingsLine);
  expect(how?.textContent).toContain("Learn as we talk");
});

it("LEARNING-CONSENT no renderer source carries the in-chat learning notice", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes("data-learning-notice") || text.includes(oldNotice) || /learning-consent["']/.test(text)) found.push(path);
    }
  };
  walk(join(process.cwd(), "src"));
  expect(found).toEqual([]);
});

it("LEARNING-CONSENT disclosure accompanies the unchanged base extraction request", async () => {
  const f = await fixture();
  await f.send();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = f.fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(String(url)).toBe("https://api.fluxrouter.ai/v1/chat/completions");
  expect(init.method).toBe("POST"); expect(init.redirect).toBe("error");
  expect(init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer learning-fixture-key", "x-flux-feature": "memory", "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" });
  expect(JSON.parse(String(init.body))).toEqual(baseRequest);
  await f.mount();
  expect(host.querySelector('section[aria-label="How it learns"]')?.textContent).toContain(settingsLine);
});

it("LEARNING-CONSENT a throwing notifier completes extraction and records one bounded diagnostic", async () => {
  const f = await fixture();
  const extraction = await import("../../server/memory/extract.ts");
  const { resetWorkerLog } = await import("../../server/memory/worker-log.ts");
  const observe = await import("../../server/observe.ts");
  resetWorkerLog();
  const diagnostic = vi.spyOn(observe, "observeLine").mockImplementation(() => {});
  extraction.setLearningFluxSendListener(() => { throw Error("owner content must not enter diagnostics"); });
  expect(await f.send()).toBe("[]");
  expect(await f.send()).toBe("[]");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(diagnostic).toHaveBeenCalledTimes(1);
  expect(diagnostic.mock.calls[0][0]).toMatch(/^\[memory-worker\] subsystem=learning cause=LEARNING_NOTICE_DELIVERY count=1 since=/);
  expect(diagnostic.mock.calls[0][0]).not.toContain("owner content");
});
