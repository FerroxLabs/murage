// A window that goes black tells you nothing.
//
// Source contracts, not render tests: the renderer suite runs in a node
// environment with no DOM. What is worth pinning here is that the two ways
// this app can paint an empty black window are both closed, because they look
// identical to a user and neither leaves a message behind.
//
// 1. An uncaught render error. React 19 unmounts the whole root, `#root`
//    empties, and `body` paints `--color-app` (#0a0a0a) over the window. The
//    app had exactly one boundary before this and it was around individual
//    chat messages.
// 2. A stale `--vvh`. It is an ABSOLUTE pixel height written from a
//    requestAnimationFrame callback, and rAF does not run while the window is
//    occluded — so a resize the app sleeps through pins the shell to a height
//    the window no longer has, and body's ground paints the rest.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the root error boundary", () => {
  const boundary = read("./RootErrorBoundary.tsx");
  const main = read("../main.tsx");

  it("wraps the whole app, not a subtree", () => {
    expect(main).toContain("RootErrorBoundary");
    // The boundary has to be OUTSIDE App, or an error thrown while App
    // renders escapes it and empties the root anyway.
    expect(main).toMatch(/<RootErrorBoundary>\s*<App \/>\s*<\/RootErrorBoundary>/);
  });

  it("catches the error rather than letting React unmount the root", () => {
    expect(boundary).toContain("getDerivedStateFromError");
    expect(boundary).toContain("componentDidCatch");
  });

  it("shows the user what broke and a way back", () => {
    // The whole point: a crash that names itself is a bug report.
    expect(boundary).toMatch(/error\?\.stack/);
    expect(boundary).toContain("componentStack");
    expect(boundary).toContain("window.location.reload()");
  });
});

describe("the shell's height", () => {
  const css = read("../styles.css");
  const viewport = read("../lib/visual-viewport.ts");

  it("never pins #root to --vvh unconditionally", () => {
    // `#root { height: var(--vvh, 100%) }` with no guard is the bug: one
    // missed rAF and the shell is stuck short forever.
    expect(css).toMatch(/#root\s*\{\s*height:\s*100%;\s*\}/);
    expect(css).toMatch(/html\[data-keyboard="open"\]\s*#root\s*\{\s*height:\s*var\(--vvh,\s*100%\);\s*\}/);
  });

  it("re-measures on the two events a visualViewport listener misses", () => {
    expect(viewport).toContain('window.addEventListener("resize", schedule)');
    expect(viewport).toContain('document.addEventListener("visibilitychange", schedule)');
    // and tears every one of them down again
    expect(viewport).toContain('window.removeEventListener("resize", schedule)');
    expect(viewport).toContain('document.removeEventListener("visibilitychange", schedule)');
  });
});
