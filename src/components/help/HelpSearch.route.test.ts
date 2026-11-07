// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L-COPY r3 option C: in a language other than English the panel's search
// never calls /api/help/search (it answers from English docs); in English it
// still does. Effects run during the static render here, so the route call
// the panel would make after typing runs too.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modWord } from "./help-copy";

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return { ...real, useEffect: (effect: () => void | (() => void)) => { effect(); } };
});

const { setLocale } = await import("@/lib/i18n");
const { ensureHelp, helpLoaders, helpStatus, resetHelpCopyForTests } = await import("@/lib/help-copy-store");
const { feedbackEnvelopeForScreen, resolveHelpScreen } = await import("@/lib/screen-envelope");
const { HelpPanel } = await import("./HelpPanel");

const LOCALES = fileURLToPath(new URL("../../locales/", import.meta.url));
const dePack = () => JSON.parse(readFileSync(LOCALES + "help/de.json", "utf8")) as Record<string, string>;
const screen = resolveHelpScreen({ activeView: "routines", connected: true });
const render = (search: (query: string, signal: AbortSignal) => Promise<never[]>, initialSearch: string) =>
  renderToStaticMarkup(createElement(HelpPanel, {
    entry: screen.entry, params: { ...screen.params, mod: modWord(false) }, title: "x", envelope: feedbackEnvelopeForScreen(screen),
    surface: "desktop", noEngine: false, onClose: vi.fn(), onOpenEngines: vi.fn(), onAskBot: vi.fn(), search, initialSearch,
  }));

const originalLoaders = { ...helpLoaders };
afterEach(async () => {
  Object.assign(helpLoaders, originalLoaders);
  vi.useRealTimers();
  await setLocale("en");
  resetHelpCopyForTests();
});

describe("which search the panel runs", () => {
  it("English still asks the docs route", async () => {
    vi.useFakeTimers();
    const route = vi.fn(async (_query: string, _signal: AbortSignal) => [] as never[]);
    render(route, "working folder");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(route).toHaveBeenCalledOnce();
    expect(route.mock.calls[0]![0]).toBe("working folder");
  });

  it("de never calls the route, typed words or not", async () => {
    helpLoaders.de = () => Promise.resolve(dePack());
    await setLocale("de");
    ensureHelp("de");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(helpStatus("de")).toBe("ready");
    vi.useFakeTimers();
    const route = vi.fn(async () => [] as never[]);
    const html = render(route, "Routine");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(route).not.toHaveBeenCalled();
    expect(html).not.toContain("Looking through the help.");
  });
});
