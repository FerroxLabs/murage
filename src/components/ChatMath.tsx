// One math span in a chat bubble, drawn by KaTeX.
//
// KaTeX loads the first time a message has math in it, with its stylesheet
// from the app's own bundle (never a CDN). Until then — or for good, if the
// package is missing or the TeX does not parse — the span shows its source.
// KaTeX's output is its own escaped HTML; with trust off, \href, \url,
// \includegraphics and the \html* commands are refused, and the size and
// macro-expansion limits stop a hostile formula from eating the renderer.
// KaTeX's HTML is then passed through DOMPurify anyway: this is model and
// channel text reaching the main window, and KaTeX has shipped escaping bugs
// before. No DOMPurify, no KaTeX: the source shows instead.
import { useEffect, useState } from "react";
import type { MathSpan } from "@/lib/chat-math";

interface KatexApi {
  renderToString(tex: string, options: Record<string, unknown>): string;
}
interface PurifyApi {
  sanitize(dirty: string, config: Record<string, unknown>): string;
}
interface MathRenderer { katex: KatexApi; purify: PurifyApi }

/** The options every formula is drawn with. Exported for the tests. */
export function katexOptions(display: boolean): Record<string, unknown> {
  return {
    displayMode: display,
    // a bad formula falls back to its source rather than KaTeX's red error
    throwOnError: true,
    // no \href, \url, \includegraphics, \htmlClass, \htmlData …
    trust: false,
    // LaTeX-compatibility nags are not the reader's problem; they are
    // neither errors nor a security boundary
    strict: "ignore",
    // em limit on \rule, \kern and friends, and on macro expansion, so
    // "\def\a{\a\a}\a" or a 10000em rule cannot freeze the window
    maxSize: 50,
    maxExpand: 500,
    // a fresh table per call: \gdef in one message must not leak into the next
    macros: {},
    output: "htmlAndMathml",
  };
}

let renderer: MathRenderer | null | undefined;
let loading: Promise<MathRenderer | null> | undefined;
function loadRenderer(): Promise<MathRenderer | null> {
  loading ??= Promise.all([
    // @ts-ignore -- optional until the package is installed; see scripts/vite-render-plugin.ts
    import("katex"),
    // @ts-ignore -- optional until the package is installed; see scripts/vite-render-plugin.ts
    import("dompurify"),
    import("katex/dist/katex.min.css"),
  ]).then(([katexModule, purifyModule]: [{ default?: KatexApi } & Partial<KatexApi>, { default?: PurifyApi }, unknown]) => {
    const katex = katexModule.default ?? (katexModule.renderToString ? (katexModule as KatexApi) : undefined);
    const purify = purifyModule.default;
    renderer = katex?.renderToString && purify?.sanitize ? { katex, purify } : null;
    return renderer;
  }, () => (renderer = null));
  return loading;
}

const rendered = new Map<string, string | null>();
const RENDERED_MAX = 500;
function draw({ katex, purify }: MathRenderer, span: MathSpan): string | null {
  const key = `${span.display ? "d" : "i"}:${span.tex}`;
  if (rendered.has(key)) return rendered.get(key)!;
  let html: string | null;
  try {
    html = purify.sanitize(katex.renderToString(span.tex, katexOptions(span.display)), {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
    });
  } catch { html = null; }
  if (rendered.size >= RENDERED_MAX) rendered.delete(rendered.keys().next().value!);
  rendered.set(key, html);
  return html;
}

export function ChatMath({ span }: { span: MathSpan }) {
  const [html, setHtml] = useState<string | null>(() => (renderer ? draw(renderer, span) : null));
  useEffect(() => {
    let alive = true;
    if (renderer) { setHtml(draw(renderer, span)); return; }
    void loadRenderer().then((ready) => { if (alive) setHtml(ready ? draw(ready, span) : null); });
    return () => { alive = false; };
  }, [span]);
  if (html === null) {
    // the source, in the same code style as inline code; a display formula
    // keeps its own line
    return span.display
      ? <span className="my-1 block overflow-x-auto"><code className="rounded bg-inset px-1 py-px text-[13px]">{span.raw}</code></span>
      : <code className="rounded bg-inset px-1 py-px text-[13px] [overflow-wrap:anywhere]">{span.raw}</code>;
  }
  return span.display
    ? <span className="chat-math-display my-1 block max-w-full overflow-x-auto overflow-y-hidden" dangerouslySetInnerHTML={{ __html: html }} />
    : <span className="chat-math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}
