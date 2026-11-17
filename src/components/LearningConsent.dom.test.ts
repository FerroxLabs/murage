// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import baseRequest from "./fixtures/learning-request.e2aa9ce.json";

const notice = "Murage learns from your chats using Flux. You can change this in Settings.";
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture(blockStorage = false) {
  vi.resetModules();
  localStorage.clear();
  if (blockStorage) {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("blocked"); });
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const extraction = await import("../../server/memory/extract.ts");
  const live = await import("../lib/live-events.ts");
  const { MemorySectionContent } = await import("./MemorySection");
  const { learningDefaultOnFor, resolveLearningConnection } = await import("../../server/memory/extractor-connections.ts");
  const { openLearningGate } = await import("../../server/testing/open-learning-gate.ts");
  // The production stream forwards the transport's contentless notification through this handler.
  const hooks = extraction as unknown as { setLearningFluxSendListener?: (fn: () => void) => void };
  const frames = live as unknown as { receiveLearningNoticeFrame?: (frame: { kind: string; learningFluxSent?: unknown }) => void };
  hooks.setLearningFluxSendListener?.(() => frames.receiveLearningNoticeFrame?.({ kind: "learning.flux-sent" }));
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "[]" } }] })));
  vi.stubGlobal("fetch", fetcher);
  const connection = resolveLearningConnection({ selected: null, instances: [], readKey: () => "learning-fixture-key", defaultOn: learningDefaultOnFor(undefined, true) });
  expect(connection).toMatchObject({ source: "default", instanceId: "@murage/flux-fast", reviewOnly: false });
  const send = () => connection.extractor!("Owner prefers daily reports.", 100, new AbortController().signal, { fence: openLearningGate() } as never);
  const mount = async () => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(createElement(MemorySectionContent, {
      status: { mode: "active", configuration: { extractorInstanceId: null }, extractors: [] },
      bots: [], events: [], cursor: null, filter: "", busy: false, historyBusy: false, refusals: {}, workspace: null,
      onAction: vi.fn(), onFilter: vi.fn(), onMore: vi.fn(), onOpen: vi.fn(), onRefresh: vi.fn(),
    })));
  };
  const unmount = async () => { await act(async () => root!.unmount()); root = undefined; host.remove(); };
  return { send, mount, unmount, fetcher, config: () => frames.receiveLearningNoticeFrame?.({ kind: "config", learningFluxSent: true }) };
}

it("LEARNING-CONSENT fresh config and Flux key show the first send once on a mounted memory surface", async () => {
  const f = await fixture();
  await f.send(); // No mounted surface yet: the notice must remain pending.
  await f.mount();
  expect(host.querySelectorAll("[data-learning-notice]")).toHaveLength(1);
  expect(host.querySelector("[data-learning-notice]")?.textContent).toBe(notice);
  await act(async () => { f.config(); });
  expect(host.querySelector("[data-learning-notice]")?.textContent).toBe(notice);
  await act(async () => { await f.send(); });
  expect(host.textContent).not.toContain(notice);
  await f.unmount();
  await f.send();
  await f.mount();
  expect(host.textContent).not.toContain(notice);
  expect(f.fetcher).toHaveBeenCalledTimes(3);
});

it("LEARNING-CONSENT throwing storage still shows the first send exactly once", async () => {
  const f = await fixture(true);
  await f.mount();
  await act(async () => { await f.send(); });
  expect(host.querySelectorAll("[data-learning-notice]")).toHaveLength(1);
  expect(host.querySelector("[data-learning-notice]")?.textContent).toBe(notice);
  await act(async () => { f.config(); });
  expect(host.querySelector("[data-learning-notice]")?.textContent).toBe(notice);
  await act(async () => { await f.send(); });
  expect(host.textContent).not.toContain(notice);
  await f.unmount();
  await f.send();
  await f.mount();
  expect(host.textContent).not.toContain(notice);
  expect(f.fetcher).toHaveBeenCalledTimes(3);
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
  expect(host.querySelector("[data-learning-notice]")?.textContent).toBe(notice);
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
