// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Help's panel chunk (HelpPanel.tsx) is fetched only when help opens. Nothing
// imports it while help is closed: no background prefetch, no idle timer, no
// static import from the always-loaded part. So a stale chunk can only fail
// on an open, and then it follows the app-wide one-reload rule
// (src/lib/chunk-reload.ts) like every other lazy panel.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => ({ count: 0 }));
// Counts every evaluation of the panel module, static or dynamic.
vi.mock("./HelpPanel", () => {
  loads.count += 1;
  return { HelpOpen: () => null };
});
// Effects run during the static render, so a timer or effect that fetched the
// panel would run here too.
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return { ...real, useEffect: (effect: () => void | (() => void)) => { effect(); } };
});

afterEach(() => { vi.useRealTimers(); });

describe("help's panel chunk loads only when help opens", () => {
  it("rendering the closed host and waiting well past any idle delay imports nothing", async () => {
    vi.useFakeTimers();
    const { HelpHost, loadHelpPanel } = await import("./HelpHost");
    const html = renderToStaticMarkup(createElement(HelpHost, { surface: "desktop", noEngines: false, enginesOff: false, firstRun: null }));
    expect(html).toContain("data-help-launcher");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loads.count).toBe(0);
    // The counter does see the chunk once help asks for it.
    await loadHelpPanel();
    expect(loads.count).toBe(1);
  });

  it("the host fetches the panel in one place only, the lazy component help renders when open", () => {
    const host = readFileSync(fileURLToPath(new URL("./HelpHost.tsx", import.meta.url)), "utf8");
    expect(host.match(/import\("\.\/HelpPanel"\)/g)).toHaveLength(1);
    expect(host.match(/loadHelpPanel\(\)/g)).toHaveLength(1);
    expect(host).toContain("retryableLazy(() => loadHelpPanel()");
    expect(host).not.toMatch(/requestIdleCallback|setTimeout\([^)]*loadHelpPanel|modulepreload/);
  });

  it("no always-loaded module imports the panel statically", () => {
    const src = fileURLToPath(new URL("../..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { if (name !== "node_modules") walk(full); }
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(src);
    // Any specifier that names the panel module, by any relative or @/ path.
    const importers = files.filter((file) => /(?:from|import)\s*\(?\s*["'][^"']*\bHelpPanel(?:\.tsx?)?["']/.test(readFileSync(file, "utf8")));
    expect(importers.map((file) => relative(src, file).split(sep).join("/"))).toEqual(["components/help/HelpHost.tsx"]);
    // The words for each screen and the tables that name them stay on the help chunk too.
    const lazyOnly = (pattern: RegExp) => files.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => relative(src, file).split(sep).join("/")).sort();
    expect(lazyOnly(/en-help\/screens\.json["']/)).toEqual(["lib/help-screen-copy.ts"]);
    expect(lazyOnly(/from\s*["'][^"']*help-screen-copy["']|import\s*["'][^"']*help-screen-copy["']/)).toEqual(["lib/screen-envelope.ts"]);
    expect(lazyOnly(/^import\s+\{[^}]*\}\s+from\s*["'][^"']*screen-envelope["']/m)).toEqual(["components/help/FeedbackForm.tsx", "components/help/HelpPanel.tsx"]);
  });
});
