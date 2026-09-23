// The diagram frame's own script. It runs only inside /mermaid-frame.html,
// which the app loads in <iframe sandbox="allow-scripts"> (no
// allow-same-origin), so this document has an opaque origin: no app DOM, no
// cookies, no storage, no desktop bridge. The page's CSP allows this one
// inline script (by hash), inline styles for mermaid's SVG, data: images and
// nothing else — no network at all.
//
// What it does: wait for a render request from the app, draw it with mermaid
// at securityLevel "strict" with HTML labels off, sanitize the SVG with
// DOMPurify, put it in the page and report the page's height. Errors are
// reported as one of four fixed words, never as text from the diagram.
//
// Built by scripts/vite-render-plugin.ts into a classic inline script (a
// module script from an opaque origin would need CORS on every chunk).
import {
  FRAME_RENDER_TIMEOUT_MS,
  MAX_DIAGRAM_SOURCE,
  parseRenderRequest,
  type FrameFailure,
  type FrameMessage,
  type RenderRequest,
} from "./protocol";

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}
interface PurifyApi {
  sanitize(dirty: string, config: Record<string, unknown>): DocumentFragment;
  addHook(name: string, hook: (node: Element) => void): void;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

let libraries: Promise<{ mermaid: MermaidApi; purify: PurifyApi } | null> | undefined;
function load() {
  libraries ??= Promise.all([
    // @ts-ignore -- optional until the package is installed; see vite-render-plugin
    import("mermaid"),
    // @ts-ignore -- optional until the package is installed; see vite-render-plugin
    import("dompurify"),
  ]).then(([mermaidModule, purifyModule]: [unknown, unknown]) => {
    // Only the few calls below are used, so the modules are read through
    // these narrow shapes rather than the packages' full overloaded types.
    const mermaid = (mermaidModule as { default?: MermaidApi } | undefined)?.default;
    const purify = (purifyModule as { default?: PurifyApi } | undefined)?.default;
    if (!mermaid?.render || !purify?.sanitize) return null;
    // Nothing in a diagram may navigate: a link inside the frame would load a
    // page into it. Hrefs go; internal url(#marker) references are
    // attributes of other names and stay.
    purify.addHook("afterSanitizeAttributes", (node) => {
      node.removeAttribute("href");
      node.removeAttribute("xlink:href");
    });
    return { mermaid, purify };
  }, () => null);
  return libraries;
}

function post(message: FrameMessage) {
  // the app is on this document's URL origin; nobody else gets the message
  window.parent.postMessage(message, location.origin);
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), FRAME_RENDER_TIMEOUT_MS);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

let renderCount = 0;
let current = -1;
const stage = document.getElementById("diagram") ?? document.body;

function reportHeight(id: number) {
  if (id !== current) return;
  const height = Math.max(stage.getBoundingClientRect().height, stage.scrollHeight);
  post({ type: "murage-mermaid:rendered", id, height });
}

async function render(request: RenderRequest) {
  current = request.id;
  const fail = (reason: FrameFailure) => { if (current === request.id) post({ type: "murage-mermaid:error", id: request.id, reason }); };
  if (request.source.length > MAX_DIAGRAM_SOURCE) return fail("too-long");
  const loaded = await load();
  if (!loaded) return fail("unavailable");
  const { mermaid, purify } = loaded;
  const dark = request.theme === "dark";
  document.documentElement.style.colorScheme = request.theme;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    theme: dark ? "dark" : "default",
    fontFamily: FONT,
    maxTextSize: MAX_DIAGRAM_SOURCE,
    maxEdges: 500,
    deterministicIds: true,
  });
  let svg: string;
  try {
    ({ svg } = await withTimeout(mermaid.render(`murage-diagram-${++renderCount}`, request.source)));
  } catch (error) {
    return fail(error instanceof Error && error.message === "timeout" ? "timeout" : "parse");
  }
  if (current !== request.id) return;
  const clean = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // mermaid themes its SVG with an inner <style>; the CSP still refuses
    // any url() it could name, since only data: images are allowed
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["foreignObject", "script", "iframe", "object", "embed", "image"],
    RETURN_DOM_FRAGMENT: true,
  });
  stage.replaceChildren(clean);
  requestAnimationFrame(() => reportHeight(request.id));
}

function start() {
  // Only ever work as a sandboxed child of the app. Opened any other way —
  // as a top-level page, or framed without the sandbox — this page does
  // nothing, because then it would share the app's origin.
  if (self.origin !== "null" || window.parent === window) return;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== location.origin) return;
    const request = parseRenderRequest(event.data);
    if (request) void render(request);
  });
  // a diagram scales with the frame's width, so a resized bubble re-reports
  if (typeof ResizeObserver === "function") new ResizeObserver(() => reportHeight(current)).observe(stage);
  post({ type: "murage-mermaid:ready" });
}

start();
