// The launcher's DOM code runs only on a phone; vitest runs in Node with no
// DOM (as in the root project), so its wiring is pinned by reading the source.
// Its decisions are tested through a fake shell in launcher.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
/** Source without comments, so a rule is checked against code, not prose. */
const code = (name: string) => source(name).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

describe("launcher wiring", () => {
  it("never builds markup from strings (everything is textContent)", () => {
    for (const file of ["./render.ts", "./main.ts", "./launcher.ts"]) {
      expect(code(file)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
    }
  });

  it("keeps the pairing credential out of storage and logs", () => {
    for (const file of ["./render.ts", "./main.ts", "./launcher.ts"]) {
      expect(code(file)).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
    }
  });

  it("listens for closes before the first screen, so none is missed", () => {
    const launcher = code("./launcher.ts");
    const listen = launcher.indexOf('shell.addListener("workspaceClosed"');
    expect(listen).toBeGreaterThan(-1);
    expect(launcher.indexOf("await listen();")).toBeLessThan(launcher.indexOf("firstScreen(state)"));
    expect(launcher).toContain("screenForClose(unshown, state.workspaces) : firstScreen(state)");
  });

  it("starts the launcher from main.ts with the real plugin, and lets go of the listener when the page goes", () => {
    const main = code("./main.ts");
    expect(main).toContain("createLauncher(shell,");
    expect(main).toContain("launcher.boot()");
    expect(main).toMatch(/addEventListener\("pagehide"[\s\S]*launcher\.dispose\(\)/);
  });

  it("redraws a screen in place when asked: focus and scroll stay where they were (fix round 1)", () => {
    const render = code("./render.ts");
    expect(render).toMatch(/export function render\(root: HTMLElement, view: View, act: Act, draft\?: Draft, keep = false\)/);
    expect(render).toMatch(/if \(keep\) \{[\s\S]*focusLike\([\s\S]*window\.scrollTo\(0, scrolled\)[\s\S]*\} else \{\s*root\.replaceChildren\(screen\);\s*title\.focus\(\{ preventScroll: true \}\);[^}]*window\.scrollTo\(0, 0\);/);
    expect(code("./main.ts")).toContain("(view, act, draft, keep) => render(root, view, act, draft, keep)");
  });

  it("reads Tailscale again when the app comes back (from Tailscale or the store)", () => {
    const main = code("./main.ts");
    expect(main).toContain("listenForRecovery(document, window, () => navigator.onLine");
    expect(main).toContain("void launcher.resume()");
    expect(main).toContain("stopRecovery()");
  });

  it("the Tailscale watch only reads while the app is on screen (first run)", () => {
    expect(code("./main.ts")).toContain('createLauncher(shell, (view, act, draft, keep) => render(root, view, act, draft, keep), Date.now, () => document.visibilityState === "visible")');
  });

  it("draws the welcome's Murage mark from the app icon's own shapes, with no fetch and no markup strings", () => {
    const render = code("./render.ts");
    expect(render).toMatch(/if \(view\.mark\)[\s\S]*murageMark\(\)/);
    expect(render).toContain('document.createElementNS(SVG, name)');
    const mark = render.slice(render.indexOf("function murageMark"), render.indexOf("function button"));
    expect(mark).not.toMatch(/fetch\(|new Image|\.src =/);
    // brand/app-icon.svg, the splash's tile: its galaxy path and Forge Orange.
    const icon = readFileSync(new URL("../../../brand/app-icon.svg", import.meta.url), "utf8");
    const galaxy = /<path d="(M16\.005[^"]+)"/.exec(icon)![1]!;
    expect(render).toContain(galaxy);
    expect(render).toContain("#ff6b35");
  });

  it("first-run screens: text in the upper middle, buttons at the bottom within thumb reach, a quiet step line", () => {
    const render = code("./render.ts");
    expect(render).toMatch(/view\.layout === "firstRun"[\s\S]*first-run/);
    expect(render).toMatch(/`Step \$\{view\.step\} of 4`/);
    const css = source("./styles.css");
    expect(css).toMatch(/#app \{[^}]*display: flex;[^}]*flex-direction: column;/);
    expect(css).toMatch(/\.screen\.first-run \{[^}]*flex: 1;/);
    expect(css).toMatch(/\.first-run \.actions \{[^}]*margin-top: auto;/);
    expect(css).toMatch(/\.button \{[^}]*min-height: 48px;/);
    expect(css).toContain("env(safe-area-inset-bottom");
  });

  it("draws Get your code ready's picture from the bundled files, light and dark, with its alt text", () => {
    const render = code("./render.ts");
    expect(render).toMatch(/if \(view\.image\)[\s\S]*el\("picture"/);
    expect(render).toContain('source.media = "(prefers-color-scheme: dark)"');
    expect(render).toContain("img.alt = view.image.alt");
    expect(render).toMatch(/img\.width = view\.image\.width;[\s\S]*img\.height = view\.image\.height;/);
    expect(source("./styles.css")).toMatch(/\.shot img \{[^}]*width: 100%;[^}]*height: auto;/);
    // Bundled with the launcher: no fetch, nothing from the network.
    expect(code("./screens.ts")).toMatch(/import \w+ from "\.\/assets\/desktop-phone-light\.webp";/);
    expect(code("./screens.ts")).toMatch(/import \w+ from "\.\/assets\/desktop-phone-dark\.webp";/);
  });

  it("labels the typed-pairing fields the way the E2E finds them", () => {
    const render = source("./render.ts");
    expect(render).toContain('field("address", "Address"');
    expect(render).toContain('field("code", "Six-digit code"');
    expect(render).toContain('inputMode = "numeric"');
    expect(render).toContain('autocomplete = "one-time-code"');
  });

  it("connects on Return in the code field (two fields and no submit button never submit on their own)", () => {
    const render = code("./render.ts");
    expect(render).toMatch(/code\.input\.addEventListener\("keydown"[\s\S]{0,200}act\(connect, values\(\)\)/);
    expect(render).toContain('enterKeyHint = "go"');
    // Neither field acts on an Enter that finishes an IME composition (fix round 1).
    expect(render).toMatch(/address\.input\.addEventListener\("keydown", \(event\) => \{\s*if \(event\.key !== "Enter" \|\| event\.isComposing\) return;/);
    expect(render).toMatch(/code\.input\.addEventListener\("keydown", \(event\) => \{\s*if \(event\.key !== "Enter" \|\| event\.isComposing\) return;/);
  });

  it("moves focus to each new screen's title", () => {
    const render = code("./render.ts");
    expect(render).toMatch(/title\.tabIndex = -1/);
    expect(render).toMatch(/title\.focus\(/);
    expect(render).toMatch(/el\("button"/);
    expect(render).not.toMatch(/el\("(?:div|span|a)"[^)]*\)\.addEventListener\("click"/);
  });

  it("keeps touch targets at 48 px and inputs at 16 px", () => {
    const css = source("./styles.css");
    expect(css).toMatch(/\.button\s*\{[^}]*min-height: 48px/);
    expect(css).toMatch(/\.field-input\s*\{[^}]*font-size: 16px/);
    expect(css).toMatch(/\.row-main\s*\{[^}]*min-height: (?:4[89]|[5-9]\d)px/);
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("prefers-color-scheme: dark");
  });

  it("pads for the status bar even where Android reports a zero inset", () => {
    const css = source("./styles.css");
    expect(css).toContain("max(env(safe-area-inset-top, 0px), 48px)");
    expect(css).toContain("max(env(safe-area-inset-bottom, 0px), 24px)");
  });

  it("keeps the launcher page's strict CSP", () => {
    const html = source("../index.html");
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).toContain("script-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it("announces a screen once: title focus and the alert, no live region on #app (fix round 1)", () => {
    const html = source("../index.html");
    expect(html).toContain('id="app"');
    expect(html).not.toMatch(/id="app"[^>]*aria-live/);
    expect(html).not.toContain("aria-live");
  });
});
