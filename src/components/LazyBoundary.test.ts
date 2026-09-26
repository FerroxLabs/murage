// M7: a lazy panel whose chunk fails a second time inside chunk-reload's
// minute used to reach RootErrorBoundary and take the whole app down. Each
// lazy surface now has its own boundary with a retry that imports afresh.
import { readFileSync } from "node:fs";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LAZY_RETRY_TEXT, LazyBoundary, PANEL_ERROR_RETRY, PANEL_ERROR_TEXT, isChunkLoadError, retryableLazy } from "./LazyBoundary";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

describe("retryableLazy", () => {
  it("keeps one component identity, and a retry imports the chunk again", () => {
    const load = vi.fn(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    const panel = retryableLazy(load as unknown as () => Promise<{ default: (props: { a: number }) => null }>);
    const first = panel.Component({ a: 1 }) as ReactElement;
    expect(isValidElement(first)).toBe(true);
    panel.retry();
    const second = panel.Component({ a: 1 }) as ReactElement;
    // a fresh React.lazy: the old one would replay its rejection forever
    expect(second.type).not.toBe(first.type);
    expect(second.props).toEqual({ a: 1 });
  });
});

describe("LazyBoundary", () => {
  const boundary = (props: Partial<ConstructorParameters<typeof LazyBoundary>[0]> = {}) => {
    const onRetry = vi.fn();
    const instance = new LazyBoundary({ children: createElement("span", null, "panel"), onRetry, ...props });
    instance.setState = ((update: object) => { instance.state = { ...instance.state, ...update }; }) as never;
    return { instance, onRetry };
  };

  it("shows the panel until a load fails, then only the retry, which reloads the app", () => {
    const reload = vi.fn();
    const { instance, onRetry } = boundary({ reload });
    expect(renderToStaticMarkup(instance.render() as ReactElement)).toBe("<span>panel</span>");
    const chunk = new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1:8799/assets/SettingsModal-abc.js");
    instance.state = { ...instance.state, ...LazyBoundary.getDerivedStateFromError(chunk) };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    instance.componentDidCatch(chunk);
    expect(onRetry).toHaveBeenCalledOnce();
    const html = renderToStaticMarkup(instance.render() as ReactElement);
    expect(LAZY_RETRY_TEXT).toBe("Couldn't open this. Tap to retry.");
    expect(html).toContain("Couldn&#x27;t open this. Tap to retry.");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("panel");
    // Chromium caches a failed import() in the module map: only a new
    // document fetches the chunk again (verification f5).
    instance.retry();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads directly, never through chunk-reload's once-a-minute guard", () => {
    const source = read("./LazyBoundary.tsx");
    expect(source).toContain("(this.props.reload ?? (() => window.location.reload()))();");
    expect(source).not.toContain("chunk-reload\"");
  });

  it("offers Close when the panel can be dismissed, so a dead network is not a trap", () => {
    const onDismiss = vi.fn();
    const { instance } = boundary({ onDismiss });
    instance.state = { failed: true, broken: false };
    const html = renderToStaticMarkup(instance.render() as ReactElement);
    expect(html).toContain("Close");
    const inline = boundary({ inline: true }).instance;
    inline.state = { failed: true, broken: false };
    expect(renderToStaticMarkup(inline.render() as ReactElement)).not.toContain("fixed inset-0");
  });
});

// 0.1.60 audit L1: any render error was treated as a failed chunk load, and
// its "retry" reloaded the whole window (ending a live call).
describe("a panel that throws while rendering is not a failed load", () => {
  it("knows a chunk-load failure in each engine's words, and nothing else", () => {
    for (const message of ["Failed to fetch dynamically imported module: https://x/a.js", "error loading dynamically imported module: https://x/a.js", "Importing a module script failed.", "Unable to preload CSS for /assets/a.css"])
      expect(isChunkLoadError(new TypeError(message)), message).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
    for (const error of [new TypeError("Cannot read properties of undefined (reading 'map')"), new Error("chunk"), null, undefined, "Failed"])
      expect(isChunkLoadError(error), String(error)).toBe(false);
  });

  it("stays in the panel, never reloads, and Try again draws only the panel again", () => {
    const reload = vi.fn(), onRetry = vi.fn(), onDismiss = vi.fn();
    const instance = new LazyBoundary({ children: createElement("span", null, "panel"), onRetry, onDismiss, reload });
    instance.setState = ((update: object) => { instance.state = { ...instance.state, ...update }; }) as never;
    const bug = new TypeError("Cannot read properties of undefined (reading 'map')");
    instance.state = { ...instance.state, ...LazyBoundary.getDerivedStateFromError(bug) };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    instance.componentDidCatch(bug);
    expect(error).toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(instance.render() as ReactElement);
    expect(html).toContain("Something went wrong while showing this, so it couldn&#x27;t be opened.");
    expect(html).toContain(PANEL_ERROR_RETRY);
    expect(html).toContain("Close");
    expect(html).not.toContain(LAZY_RETRY_TEXT.slice(0, 10));
    expect(PANEL_ERROR_TEXT).not.toMatch(/Cannot read|undefined/);
    instance.renderAgain();
    expect(renderToStaticMarkup(instance.render() as ReactElement)).toBe("<span>panel</span>");
    expect(reload).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

it("wraps every lazy surface: Settings, BotSettings, ComputerPanel, the calls and the editor", () => {
  const app = read("../App.tsx");
  for (const [chunk, close] of [["BotSettings", "toggleSettings"], ["Computer", "toggleComputer"], ["Settings", "toggleAppSettings"]]) {
    expect(app).toContain(`<LazyBoundary onRetry={${chunk}.retry} onDismiss={() => dispatch({ type: "${close}", open: false })}>`);
  }
  expect(app).not.toMatch(/\blazy\(/);
  const calls = read("./CallControls.tsx");
  // Close on a call screen ends the call it belongs to (and only that one)
  expect(calls).toContain("<LazyBoundary onRetry={CallChunk.retry} onDismiss={() => endCall(bot.id)}>");
  expect(calls).toContain("<LazyBoundary onRetry={GroupCallChunk.retry} onDismiss={() => endCall(group.id)}>");
  expect(calls).not.toMatch(/\blazy\(/);
  const pane = read("./WorkspacePane.tsx");
  expect(pane).toContain("<LazyBoundary inline onRetry={Editor.retry}>");
  expect(pane).not.toMatch(/\blazy\(/);
});

it("a failed call screen's Close ends that call, and leaves a newer one alone", async () => {
  vi.stubGlobal("window", { muragebox: { speechStop: vi.fn(async () => {}) } });
  const call = await import("../lib/call");
  const onDismiss = (id: string) => () => call.endCall(id);
  call.startCall("bot-1");
  const instance = new LazyBoundary({ children: null, onRetry: vi.fn(), onDismiss: onDismiss("bot-1") });
  instance.state = { failed: true, broken: false };
  const overlay = instance.render() as ReactElement<{ children: ReactElement[] }>;
  const close = (overlay.props.children as unknown as ReactElement<{ onClick: () => void; children: string }>[])
    .find((child) => child && child.props?.children === "Close")!;
  close.props.onClick();
  expect(call.currentCall()).toBeNull();
  call.startCall("bot-2");
  onDismiss("bot-1")();
  expect(call.currentCall()).toBe("bot-2");
  call.endCall();
  vi.unstubAllGlobals();
});
