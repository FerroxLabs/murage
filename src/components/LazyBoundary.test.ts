// M7: a lazy panel whose chunk fails a second time inside chunk-reload's
// minute used to reach RootErrorBoundary and take the whole app down. Each
// lazy surface now has its own boundary with a retry that imports afresh.
import { readFileSync } from "node:fs";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LAZY_RETRY_TEXT, LazyBoundary, retryableLazy } from "./LazyBoundary";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

describe("retryableLazy", () => {
  it("keeps one component identity, and a retry imports the chunk again", () => {
    const load = vi.fn(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    const panel = retryableLazy<{ a: number }>(load as never);
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

  it("shows the panel until a load fails, then only the retry", () => {
    const { instance, onRetry } = boundary();
    expect(renderToStaticMarkup(instance.render() as ReactElement)).toBe("<span>panel</span>");
    instance.state = { ...instance.state, ...LazyBoundary.getDerivedStateFromError() };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    instance.componentDidCatch(new Error("chunk"));
    // the fresh import is ready before the person taps
    expect(onRetry).toHaveBeenCalledOnce();
    const html = renderToStaticMarkup(instance.render() as ReactElement);
    expect(LAZY_RETRY_TEXT).toBe("Couldn't open this — tap to retry");
    expect(html).toContain("Couldn&#x27;t open this — tap to retry");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("panel");
    instance.retry();
    expect(renderToStaticMarkup(instance.render() as ReactElement)).toBe("<span>panel</span>");
  });

  it("offers Close when the panel can be dismissed, so a dead network is not a trap", () => {
    const onDismiss = vi.fn();
    const { instance } = boundary({ onDismiss });
    instance.state = { failed: true };
    const html = renderToStaticMarkup(instance.render() as ReactElement);
    expect(html).toContain("Close");
    const inline = boundary({ inline: true }).instance;
    inline.state = { failed: true };
    expect(renderToStaticMarkup(inline.render() as ReactElement)).not.toContain("fixed inset-0");
  });
});

it("wraps every lazy surface: Settings, BotSettings, ComputerPanel, the calls and the editor", () => {
  const app = read("../App.tsx");
  for (const [chunk, close] of [["BotSettings", "toggleSettings"], ["Computer", "toggleComputer"], ["Settings", "toggleAppSettings"]]) {
    expect(app).toContain(`<LazyBoundary onRetry={${chunk}.retry} onDismiss={() => dispatch({ type: "${close}", open: false })}>`);
  }
  expect(app).not.toMatch(/\blazy\(/);
  const calls = read("./CallControls.tsx");
  expect(calls).toContain("<LazyBoundary onRetry={CallChunk.retry}>");
  expect(calls).toContain("<LazyBoundary onRetry={GroupCallChunk.retry}>");
  expect(calls).not.toMatch(/\blazy\(/);
  const pane = read("./WorkspacePane.tsx");
  expect(pane).toContain("<LazyBoundary inline onRetry={Editor.retry}>");
  expect(pane).not.toMatch(/\blazy\(/);
});
