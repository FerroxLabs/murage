// A ```mermaid fence, drawn as a diagram. "Upstream diagram rendering, done
// right": OpenMausBot f1e066fd (#1619) rendered mermaid in the app's own
// window and injected the SVG with dangerouslySetInnerHTML. Diagram text comes
// from bots and channels, the renderer has no CSP and the desktop bridge lives
// on window.muragebox, so one mermaid or DOMPurify bypass would have been code
// running next to the bridge. Here the diagram is drawn somewhere that cannot
// reach anything:
//
// - an <iframe sandbox="allow-scripts"> with NO allow-same-origin: an opaque
//   origin with no access to this window, its storage, cookies or the bridge
//   (Electron runs the preload in the top frame only, and only on the app's
//   origin);
// - the frame page is ours, served by the app (scripts/vite-render-plugin.ts),
//   with a CSP of its own that allows no network at all;
// - inside it, mermaid runs at securityLevel "strict" with HTML labels off and
//   its SVG goes through DOMPurify before it is shown;
// - the only thing the frame can tell us is a height (bounded), a "ready", or
//   one of four failure words; every message is checked for source, origin
//   and shape (src/mermaid-frame/protocol.ts).
//
// Anything that goes wrong — a parse error, a slow render, the package not
// installed, a frame that never answers — shows the source as an ordinary
// code block with a one-line note.
import { useEffect, useRef, useState, type RefObject } from "react";
import { CodeBlock } from "./ChatMarkdown";
import {
  HOST_RENDER_TIMEOUT_MS,
  MAX_DIAGRAM_SOURCE,
  MERMAID_FRAME_PATH,
  parseFrameMessage,
  type DiagramTheme,
  type RenderRequest,
} from "@/mermaid-frame/protocol";

let nextRequestId = 1;

/** The palette of the nearest skin, read the way the Shiki blocks read it. */
function schemeOf(element: HTMLElement | null): DiagramTheme {
  if (!element || typeof getComputedStyle !== "function") return "dark";
  try {
    return getComputedStyle(element).getPropertyValue("--code-color-scheme").trim() === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Re-read the skin whenever a data-skin attribute changes anywhere. */
function useScheme(ref: RefObject<HTMLElement | null>): DiagramTheme {
  const [scheme, setScheme] = useState<DiagramTheme>("dark");
  useEffect(() => {
    const read = () => setScheme(schemeOf(ref.current));
    read();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { subtree: true, attributeFilter: ["data-skin"] });
    return () => observer.disconnect();
  }, [ref]);
  return scheme;
}

function DiagramSource({ code, note, streaming = false }: { code: string; note?: string; streaming?: boolean }) {
  return (
    <div>
      {note && <p className="mt-2 text-[12px] text-ink-secondary">{note}</p>}
      <CodeBlock code={code} lang="mermaid" streaming={streaming} />
    </div>
  );
}

type FrameState = { status: "drawing" } | { status: "drawn"; height: number } | { status: "failed"; note: string };

const NOTES = {
  parse: "This diagram could not be drawn, so here is its source.",
  timeout: "This diagram took too long to draw, so here is its source.",
  "too-long": "This diagram is too long to draw, so here is its source.",
  unavailable: "Diagrams are not available in this version, so here is the source.",
} as const;

export function MermaidDiagram({ code, streaming }: { code: string; streaming: boolean }) {
  // a half-arrived diagram is only ever source; drawing waits for the end
  if (streaming) return <DiagramSource code={code} streaming />;
  if (code.length > MAX_DIAGRAM_SOURCE) return <DiagramSource code={code} note={NOTES["too-long"]} />;
  return <DiagramFrame code={code} />;
}

function DiagramFrame({ code }: { code: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const scheme = useScheme(box);
  const [state, setState] = useState<FrameState>({ status: "drawing" });
  const drawn = useRef(false);
  drawn.current = state.status === "drawn";

  useEffect(() => {
    const id = nextRequestId++;
    let ready = false;
    // a frame that never answers is treated like one that failed
    const timer = setTimeout(() => setState((previous) => (previous.status === "drawn" ? previous : { status: "failed", note: ready ? NOTES.timeout : NOTES.unavailable })), HOST_RENDER_TIMEOUT_MS);
    setState((previous) => (previous.status === "drawn" ? previous : { status: "drawing" }));
    const send = () => {
      const target = frame.current?.contentWindow;
      if (!target) return;
      const request: RenderRequest = { type: "murage-mermaid:render", id, source: code, theme: scheme };
      // An opaque origin cannot be named as a target, so "*" — the frame is
      // the element we created, pointing at our own page, and what it is sent
      // is diagram text already shown in this message.
      target.postMessage(request, "*");
    };
    const onMessage = (event: MessageEvent) => {
      // only our frame, only from an opaque origin, only the three shapes
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== "null") return;
      const message = parseFrameMessage(event.data);
      if (!message) return;
      if (message.type === "murage-mermaid:ready") { ready = true; send(); return; }
      if (message.id !== id) return;
      if (message.type === "murage-mermaid:rendered") { clearTimeout(timer); setState({ status: "drawn", height: message.height }); }
      else { clearTimeout(timer); setState({ status: "failed", note: NOTES[message.reason] }); }
    };
    window.addEventListener("message", onMessage);
    // a theme change re-sends to a frame that is already up; on first mount
    // the frame is still loading and its "ready" triggers the send
    if (drawn.current) send();
    return () => { window.removeEventListener("message", onMessage); clearTimeout(timer); };
  }, [code, scheme]);

  if (state.status === "failed") return <DiagramSource code={code} note={state.note} />;
  const height = state.status === "drawn" ? state.height : 0;
  return (
    <div ref={box} className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset" data-mermaid-state={state.status}>
      {state.status === "drawing" && <p className="px-3 py-2 text-[12px] text-ink-secondary">Drawing diagram…</p>}
      <iframe
        ref={frame}
        title="Diagram"
        src={MERMAID_FRAME_PATH}
        // allow-scripts ONLY. Adding allow-same-origin here would hand the
        // frame this window, its storage and the desktop bridge.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="block w-full border-0"
        style={{ height, colorScheme: scheme }}
      />
    </div>
  );
}
