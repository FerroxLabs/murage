// English test-only controls. This module is imported only by the statically
// guarded port; never import it from an unguarded renderer path.
import { createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AskRecord } from "./HelpAsk";
import { createScrollback } from "@/lib/scrollback";
import type { api, useStore, Bot, Action } from "@/state/store";
import type { TurnLive } from "@/state/turn-status";
type Scope = ReturnType<typeof useStore>;
type Route = "send" | "stop" | "remove" | "state" | "page";
type Fault = { kind: "hold" | "fail" | "refuse" | "answer"; value?: any };
export function createDriver(render: () => void, revoke: () => void = () => {}) {
  const marker = "HELP_ASK_FIXTURE_ONLY";
  let overrides: Record<string, any> = {}, livePatch: Partial<TurnLive> = {}, streams: Record<string, string> = {};
  let base: Scope | undefined, revision = 0;
  let pageApi: typeof api | undefined;
  let pages: ReturnType<typeof createScrollback> | undefined;
  const bots = new Map<string, Partial<Bot>>();
  const faults = new Map<Route, Fault[]>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const aborts = new Map<AbortSignal, Map<() => void, () => void>>();
  const requests: any[] = [], observations: any[] = [];
  const held = new Map<number, (fault?: Fault) => void>();
  const callbacks = new Map<number, () => void>();
  let holdCallbacks = false, sequence = 0;
  const wrappers = new WeakMap<Scope["dispatch"], Map<number, Scope["dispatch"]>>();
  const emit = () => { revision++; render(); };
  const callback = (run: () => void) => { if (holdCallbacks) callbacks.set(++sequence, run); else run(); };
  function request(route: Route, payload: unknown, signal: AbortSignal | undefined, real: () => Promise<any>) {
    const id = ++sequence;
    const row = { id, route, payload, signal, settled: false };
    requests.push(row);
    const execute = (fault?: Fault): Promise<any> => {
      if (!fault) return real();
      if (fault.kind === "hold") return new Promise((resolve, reject) => held.set(id, (next) => { held.delete(id); execute(next).then(resolve, reject); }));
      if (fault.kind === "answer") return Promise.resolve(fault.value);
      return Promise.reject(Object.assign(new Error("Help fixture response"), fault.kind === "refuse"
        ? { status: 400, body: { code: "fixture_refused" } } : fault.value ?? {}));
    };
    return execute(faults.get(route)?.shift()).finally(() => { row.settled = true; });
  }
  function dispatchFor(real: Scope["dispatch"]) {
    let versions = wrappers.get(real);
    if (!versions) { versions = new Map(); wrappers.set(real, versions); }
    const identity = overrides.dispatch ?? 0;
    if (!versions.has(identity)) versions.set(identity, (action: Action) => {
      if (action.type === "send") {
        void request("send", { ...action, onReceipt: undefined, onError: undefined }, undefined,
          () => new Promise((resolve, reject) => real({ ...action, onReceipt: resolve, onError: (error: unknown) => { reject(error); return true; } })))
          .then((receipt) => callback(() => action.onReceipt?.(receipt)), (error) => callback(() => action.onError?.(error)));
      } else if (action.type === "cancelQueued") {
        void request("remove", { botId: action.botId, queueId: action.queueId }, action.signal,
          () => new Promise((resolve, reject) => real({ ...action, onDone: () => resolve(undefined), onError: (error: unknown) => { reject(error); return true; } })))
          .then(() => callback(() => action.onDone?.()), (error) => callback(() => action.onError?.(error)));
      } else if (action.type === "loadFirstPage") {
        const bot = base?.state.bots.find((b) => b.threadId === action.threadId);
        if (bot && bots.get(bot.id)?.messagesUnloaded && pageApi) {
          // The production scrollback controller, reading the injected unloaded
          // scope. A released page uses the original API, not a synthetic success.
          pages ??= createScrollback({
            getState: () => driver.scope(base!).state,
            request: (path) => new Promise<void>((resolve) => setTimeout(resolve, 1))
              .then(() => request("page", { path }, undefined, () => pageApi!(path))),
            onError: () => {},
            dispatch: (event) => {
              const owner = base?.state.bots.find((b) => b.threadId === event.threadId);
              if (!owner) return;
              const patch = bots.get(owner.id);
              if (event.type === "firstPageStarted") bots.set(owner.id, { ...patch, firstPageEvents: [] });
              else if (event.type === "firstPageFailed") bots.set(owner.id, { ...patch, firstPageEvents: undefined });
              else if (event.type === "firstPage") bots.set(owner.id, { ...patch,
                messages: event.page.messages ?? [], messagesUnloaded: undefined, firstPageEvents: undefined });
              emit();
            },
          });
          void pages.loadFirstPage(action.threadId);
        } else {
          void request("page", action, undefined, async () => real(action));
        }
      } else real(action);
    });
    return versions.get(identity)!;
  }
  let probeRoot: Root | undefined;
  let changeProbe: ((dependency: string) => void) | undefined;
  const driver = {
    async mountPageProbe() {
      const { useAskPage } = await import("./HelpAsk");
      const loads = { current: { key: "1:probe-task", tries: 1 } };
      const initial: AskRecord = { gen: 1, botId: "probe-bot", threadId: "probe-task", sendId: "probe-send", question: "Q", text: "Q", phase: "accepted" };
      const dispatchForProbe = (identity: number) => (action: { type: "loadFirstPage"; threadId: string }) => {
        void request("page", { ...action, probe: true, dispatch: identity }, undefined, async () => ({}));
      };
      const firstDispatch = dispatchForProbe(0);
      function Probe() {
        const [input, setInput] = useState({ record: initial, dispatch: firstDispatch, identity: 0 });
        changeProbe = dependency => {
          const record = dependency === "record" ? { ...input.record, threadId: "replacement-task" } : input.record;
          loads.current = { key: `${record.gen}:${record.threadId}`, tries: 1 };
          setInput({ record, dispatch: dependency === "dispatch" ? dispatchForProbe(1) : input.dispatch,
            identity: dependency === "dispatch" ? 1 : input.identity });
        };
        useEffect(() => { driver.observe("pageProbeMount", true); }, []);
        useAskPage({ record: input.record, dispatch: input.dispatch, needsPage: true, loads });
        useEffect(() => { driver.observe("pageProbeInput", { record: input.record.threadId, dispatch: input.identity, needsPage: true }); }, [input]);
        return null;
      }
      probeRoot = createRoot(document.createElement("div"));
      probeRoot.render(createElement(Probe));
    },
    changePageProbe(dependency: string) { changeProbe?.(dependency); },
    unmountPageProbe() { probeRoot?.unmount(); probeRoot = undefined; changeProbe = undefined; },
    marker,
    setTimeout(run: () => void, ms: number) {
      const handle = setTimeout(() => { timers.delete(handle); run(); }, ms);
      timers.add(handle); return handle;
    },
    clearTimeout(handle: ReturnType<typeof setTimeout> | undefined) {
      if (handle !== undefined) timers.delete(handle);
      clearTimeout(handle);
    },
    addAbort(signal: AbortSignal | undefined, run: () => void) {
      if (!signal) return;
      let listeners = aborts.get(signal);
      if (!listeners) { listeners = new Map(); aborts.set(signal, listeners); }
      const wrapped = () => { listeners!.delete(run); run(); };
      listeners.set(run, wrapped); signal.addEventListener("abort", wrapped, { once: true });
    },
    removeAbort(signal: AbortSignal | undefined, run: () => void) {
      if (!signal) return;
      const listeners = aborts.get(signal), wrapped = listeners?.get(run);
      signal.removeEventListener("abort", wrapped ?? run); listeners?.delete(run);
    },
    scope(input: Scope, realApi?: typeof api): Scope {
      base = input;
      if (realApi) pageApi = realApi;
      let roster = input.state.bots.map((bot) => ({ ...bot, ...bots.get(bot.id) }));
      if (overrides.bots) roster = overrides.bots;
      return { ...input, dispatch: dispatchFor(input.dispatch), state: { ...input.state,
        bots: roster, ...(overrides.signedOut !== undefined ? { signedOut: overrides.signedOut } : {}),
        ...(overrides.account !== undefined ? { config: { ...input.state.config, profile: { ...input.state.config?.profile, email: overrides.account } } } : {}),
        ...(overrides.pendingQueued ? { pendingQueued: overrides.pendingQueued } : {}),
      } } as Scope;
    },
    api(real: typeof api): typeof api {
      return (path, init) => request(path.includes("/interrupt") ? "stop" : "state", { path, body: init?.body }, init?.signal ?? undefined, () => real(path, init));
    },
    live(value: TurnLive) { return { ...value, ...livePatch }; },
    stream(value: Record<string, string>) { return { ...value, ...streams }; },
    observe(kind: string, value: unknown) { observations.push({ id: ++sequence, kind, value }); },
    // Change only the named dimension. `bots` permits a non-Chief before the
    // Chief, replacement Chief, and a hidden Chief without replacing React.
    setScope(key: "account" | "dispatch" | "signedOut" | "bots" | "pendingQueued", value: unknown) { overrides = { ...overrides, [key]: value }; if (key === "signedOut" && value === true) revoke(); emit(); },
    patchBot(id: string, patch: Partial<Bot>) { bots.set(id, { ...bots.get(id), ...patch }); emit(); },
    hint(patch: Partial<TurnLive>) { livePatch = { ...livePatch, ...patch }; emit(); },
    streamAt(threadId: string, text: string) { streams[threadId] = text; emit(); },
    render() { emit(); },
    respond(route: Route, ...queue: Fault[]) { faults.set(route, queue); },
    failPages(count: number) { faults.set("page", Array.from({ length: count }, () => ({ kind: "fail" }))); },
    release(id: number, answer?: Fault) { const run = held.get(id); if (!run) throw Error(`No held request ${id}`); run(answer); },
    holdCallbacks(value = true) { holdCallbacks = value; },
    releaseCallback(id: number) { const run = callbacks.get(id); if (!run) throw Error(`No callback ${id}`); callbacks.delete(id); run(); },
    snapshot() {
      // Copies only: CDP cannot mutate a record, attempt or signal through observation.
      const observed = observations.map(({ id, kind, value }) => ({ id, kind, value: typeof value === "function" ? value() : value }));
      const timerCount = timers.size;
      const listenerCount = [...aborts.values()].reduce((sum, listeners) => sum + listeners.size, 0);
      return JSON.parse(JSON.stringify({ marker, revision, timerCount, listenerCount, requests: requests.map(({ signal, ...row }) => ({ ...row, aborted: signal?.aborted ?? false })),
        observations: observed,
        held: [...held.keys()], callbacks: [...callbacks.keys()], reads: requests.filter((r) => r.route === "state").length,
        bots: base?.state.bots, selectedId: base?.state.selectedId, activeView: base?.state.activeView, overrides }));
    },
    reset() { holdCallbacks = false; overrides = {}; livePatch = {}; streams = {}; bots.clear(); faults.clear(); emit(); },
  };
  return driver;
}
