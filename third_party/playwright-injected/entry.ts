// The page-side half of the built-in browser's snapshot: Playwright's
// accessibility-tree snapshot (the `[ref=e12]` YAML that playwright-mcp
// hands models), bundled into one script and evaluated in a bot's tab over
// CDP. Nothing here talks to Electron; it only knows the DOM.
//
// Everything under ./src and ./isomorphic is vendored from Microsoft
// Playwright (Apache-2.0, see LICENSE and UPSTREAM_COMMIT) unmodified. This
// file is ours: it exposes the pieces the surface needs on `window.__ombBrowser`
// and keeps the ref → element table of the last snapshot so a click on
// `e12` resolves to the element the model was shown.
import { generateAriaTree, renderAriaTreeAsJSON, type AriaSnapshot } from "./src/ariaSnapshot";
import { renderAriaSnapshotAsYaml } from "./isomorphic/ariaSnapshotRenderer";

const VERSION = 1;
const DEFAULT_MAX_CHARS = 60_000;

let last: AriaSnapshot | null = null;

type SnapshotResult = {
  version: number;
  yaml: string;
  refs: string[];
  truncated: boolean;
  iframes: number;
};

type BoxResult =
  | { found: false }
  | { found: true; connected: false }
  | { found: true; connected: true; visible: boolean; x: number; y: number; width: number; height: number };

function snapshot(maxChars: number = DEFAULT_MAX_CHARS): SnapshotResult {
  const root = document.body ?? document.documentElement;
  const tree = generateAriaTree(root, { mode: "ai" });
  last = tree;
  const { json } = renderAriaTreeAsJSON(tree, { mode: "ai" });
  let yaml = renderAriaSnapshotAsYaml(json);
  let truncated = false;
  if (yaml.length > maxChars) {
    yaml = `${yaml.slice(0, maxChars)}\n…(snapshot truncated at ${maxChars} characters; browser_read shows the text)`;
    truncated = true;
  }
  return { version: VERSION, yaml, refs: [...tree.info.keys()], truncated, iframes: tree.iframeRefs.length };
}

function elementForRef(ref: string): Element | null {
  return last?.info.get(ref)?.element ?? null;
}

/** Two presented frames, or a short wait when the view is throttled (an
 * occluded or unfocused view may never run requestAnimationFrame). */
const nextFrames = (count: number, maxMs = 150): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const tick = (left: number) => (left <= 0 ? finish() : requestAnimationFrame(() => tick(left - 1)));
    tick(count);
    setTimeout(finish, maxMs);
  });

/** Where a ref is on screen right now. Scrolls it into view first, the
 * same way a person would before clicking, then lets the compositor catch
 * up: synthetic input is hit-tested against the last presented frame, so a
 * click dispatched in the same task as the scroll lands on stale pixels. */
async function boxForRef(ref: string): Promise<BoxResult> {
  const element = elementForRef(ref);
  if (!element) return { found: false };
  if (!element.isConnected) return { found: true, connected: false };
  try {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  } catch {
    // some elements refuse; the rect below is still the truth
  }
  await nextFrames(2);
  const rect = element.getBoundingClientRect();
  const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  return {
    found: true,
    connected: true,
    visible,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
  };
}

function focusRef(ref: string): boolean {
  const element = elementForRef(ref);
  if (!element) return false;
  const focusable = element as HTMLElement & { focus?: () => void };
  if (focusable.focus) focusable.focus();
  return document.activeElement === element || element.contains(document.activeElement);
}

declare global {
  interface Window {
    __ombBrowser?: {
      version: number;
      snapshot: typeof snapshot;
      elementForRef: typeof elementForRef;
      boxForRef: typeof boxForRef;
      focusRef: typeof focusRef;
    };
  }
}

window.__ombBrowser = { version: VERSION, snapshot, elementForRef, boxForRef, focusRef };
