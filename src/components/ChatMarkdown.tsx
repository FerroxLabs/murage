// Real markdown for bot bubbles: react-markdown + GFM (tables, task lists,
// strikethrough, autolinks) with a chromed code block — language label, copy
// button, lazy Shiki highlighting. Model output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. While a message is still streaming, a code block renders
// as plain <pre> until its content has held still for STREAM_SETTLE_MS (the
// fence is very likely complete), then highlights and caches — so the settled
// bubble, a fresh component instance, mounts straight from cache instead of
// popping from plain to highlighted.
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Download, WrapText } from "lucide-react";
import { codeFileName, codeLanguageLabel, codeLineLabel, saveCodeSnippet } from "@/lib/code-block";
import { t } from "@/lib/i18n";
import { isRasterDataUrl, MarkdownImage } from "./ImageMedia";

// react-markdown drops every data: URL. Raster image bytes already inside the
// message are the one exception worth keeping (they cost no request); links,
// SVG and every other scheme keep the default treatment.
const urlTransform: UrlTransform = (url, key, node) =>
  key === "src" && node.tagName === "img" && isRasterDataUrl(url) ? url : defaultUrlTransform(url);

// tiny highlight cache so revisiting a thread doesn't re-tokenize settled
// blocks; keys are content-hashed and capped. Streamed partials may land here
// under their own hash — harmless (never collides with the final content's
// key, and the cap evicts it), and the final content's entry is exactly what
// makes the settled bubble render highlighted on mount.
const highlightCache = new Map<string, string>();
const CACHE_MAX = 200;
// how long a streaming block's content must be unchanged before we spend a
// tokenize on it — long enough to skip per-token churn mid-fence, short
// enough that the highlight lands before the stream settles
const STREAM_SETTLE_MS = 250;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// A markdown link whose target is a file on this machine: bots hand over
// bot-created documents as absolute paths or file:// URLs. Web links stay
// ordinary anchors handled by the shell's window-open policy.
// A leading slash covers macOS and Linux; "C:\…" and "C:/…" cover Windows,
// where a file:// URL's pathname also arrives as "/C:/…".
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;
const absolutePath = (value: string): string | null => {
  if (value.startsWith("/") && WINDOWS_PATH.test(value.slice(1))) return value.slice(1);
  if (value.startsWith("/") || WINDOWS_PATH.test(value)) return value;
  return null;
};

const localFilePath = (href?: string): string | null => {
  if (!href) return null;
  // URL schemes are case-insensitive, so FILE:// is as valid as file://
  if (/^file:\/\//i.test(href)) {
    try {
      return absolutePath(decodeURIComponent(new URL(href).pathname));
    } catch {
      return null;
    }
  }
  return absolutePath(href);
};

export function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyRevision = useRef(0);
  const currentCode = useRef(code); currentCode.current = code;
  useEffect(() => {
    copyRevision.current++; setCopied(false); setCopyError(false); setSaveError(false); clearTimeout(copyTimer.current);
    return () => { copyRevision.current++; clearTimeout(copyTimer.current); };
  }, [code]);

  useEffect(() => {
    const key = `${lang}:${hash(code)}`;
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    setHtml(null);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const highlight = () => {
      import("shiki")
        .then((shiki) =>
          shiki.codeToHtml(code, {
            lang: lang || "text",
            themes: { light: "github-light-default", dark: "github-dark-default" },
            defaultColor: "light-dark()",
          }),
        )
        .then((out) => {
          if (!alive) return;
          if (highlightCache.size >= CACHE_MAX) {
            const first = highlightCache.keys().next().value;
            if (first) highlightCache.delete(first);
          }
          highlightCache.set(key, out);
          setHtml(out);
        })
        .catch(() => {
          /* unknown language or shiki failed — the plain <pre> stays */
        });
    };
    if (streaming) {
      // any earlier highlight is of a shorter snapshot — drop it so the
      // growing plain <pre> shows the real content, then wait for the block
      // to hold still. The effect re-runs (and this cleanup clears the timer)
      // on every content change, which is the debounce.
      timer = setTimeout(highlight, STREAM_SETTLE_MS);
    } else {
      highlight();
    }
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [code, lang, streaming]);

  const copy = async () => {
    const revision = ++copyRevision.current;
    setCopied(false); setCopyError(false); clearTimeout(copyTimer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(code);
      if (revision !== copyRevision.current || currentCode.current !== code) return;
      setCopied(true); copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch { if (revision === copyRevision.current) setCopyError(true); }
  };

  // #979 (adapted): Save hands the same bytes Copy would to the browser's own
  // download. The browser owns the save dialog and its cancel, so there is no
  // "Saved" state here: a click is not proof a file was written.
  const saveName = codeFileName(lang);
  const save = () => {
    setSaveError(false);
    try { if (!saveCodeSnippet(saveName, code)) setSaveError(true); }
    catch { setSaveError(true); }
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between gap-2 border-b border-hairline/30 bg-raised/30 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2"><span title={codeLanguageLabel(lang)} className="min-w-0 truncate rounded border border-hairline/40 bg-raised px-1.5 py-0.5 text-[11px] font-medium text-ink">{codeLanguageLabel(lang)}</span><span className="shrink-0 text-[11px] text-ink-secondary">{codeLineLabel(code)}</span></div>
        <div className="flex shrink-0 items-center gap-1">
        <button type="button" aria-label={wrapped ? "Disable line wrapping" : "Wrap long lines"} aria-pressed={wrapped} onClick={() => setWrapped(value => !value)} className="flex min-h-8 items-center gap-1 rounded px-2 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"><WrapText size={13} aria-hidden="true" /><span className="max-sm:hidden">{wrapped ? "Unwrap" : "Wrap"}</span></button>
        <button type="button" onClick={save} aria-label={t("chatCode.saveAs", { name: saveName })} title={t("chatCode.saveAs", { name: saveName })} className="flex min-h-8 items-center gap-1 rounded px-2 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"><Download size={13} aria-hidden="true" /><span className="max-sm:hidden">{t("chatCode.save")}</span></button>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy code"
          className="flex min-h-8 items-center gap-1 rounded px-2 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
          title="Copy code"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
        </div>
      </div>
      {copyError && <p role="alert" className="px-3 py-2 text-[12px] text-danger">Could not copy. Select the code and copy it manually.</p>}
      {saveError && <p role="alert" className="px-3 py-2 text-[12px] text-danger">{t("chatCode.saveFailed")}</p>}
      {html ? (
        <div
          className={"text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3 " + (wrapped ? "overflow-x-hidden [&_pre]:!whitespace-pre-wrap [&_code]:!whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]" : "overflow-x-auto")}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={"p-3 text-[13px] leading-relaxed text-ink " + (wrapped ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "overflow-x-auto")}>{code}</pre>
      )}
    </div>
  );
}

// A bot handing over a file it created renders as a button, not an anchor.
// Two reasons the href is dropped rather than merely preventDefault()ed:
// an absolute path in an href resolves against the page origin, so the link
// pointed at http://127.0.0.1:8799<path> and opened the chat UI in a browser;
// and an <a href="file://…"> would still reach setWindowOpenHandler on a
// middle or modifier click, which calls shell.openExternal without the main
// process' containment check.
function LocalFileLink({ filePath, children }: { filePath: string; children?: ReactNode }) {
  const [state, setState] = useState<"idle" | "saved" | "failed">("idle");
  const [reason, setReason] = useState("");
  const [savedTo, setSavedTo] = useState("");

  const save = async () => {
    const saveFile = window.muragebox?.saveFile;
    if (!saveFile) {
      // an older shell has no save bridge; saying so beats the silent click
      // this change exists to remove
      setReason("Saving files needs a newer version of the desktop app");
      setState("failed");
      return;
    }
    try {
      const saved = await saveFile(filePath);
      // null means the user closed the save dialog, which is a decision
      // rather than a failure — say nothing
      if (!saved) return;
      setSavedTo(saved);
      setState("saved");
      setTimeout(() => setState("idle"), 4000);
    } catch (error) {
      // the bug being fixed here was a click that failed silently, so a
      // failed save says why rather than doing nothing
      setReason(error instanceof Error ? error.message : "That file could not be saved");
      setState("failed");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void save()}
        title={`Save a copy — ${filePath}`}
        className="[overflow-wrap:anywhere] text-left text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        {children}
      </button>
      {state !== "idle" && (
        <span className={`ml-1.5 text-[12px] ${state === "saved" ? "text-success" : "text-danger"}`}>
          {state === "saved" ? `Saved to ${savedTo}` : reason}
        </span>
      )}
    </>
  );
}

// Spoiler spans: GFM parses ~~text~~ to <del>; in bot messages that content
// is usually a spoiler (answers, plot points, surprises), not a deletion —
// hide it behind a tap-to-reveal chip instead of striking it through.
// Display only: the stored markdown, exports, and the model's own context
// all keep the raw ~~text~~.
function Spoiler({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return (
      <span className="relative mx-px inline-block rounded px-1 py-px">
        <span
          aria-hidden="true"
          className="pointer-events-none select-none bg-raised text-transparent [&_*]:!text-transparent [&_a]:!no-underline"
        >
          {children}
        </span>
        <button
          type="button"
          aria-label="Reveal spoiler"
          title="Reveal spoiler"
          onClick={() => setRevealed(true)}
          className="absolute inset-0 rounded bg-raised/90"
        />
      </span>
    );
  }
  return (
    <span className="mx-px inline rounded px-1 py-px text-[13px] leading-relaxed text-ink underline decoration-dotted decoration-hairline underline-offset-2">
      {children}
      <button
        type="button"
        aria-label="Hide spoiler"
        title="Hide spoiler"
        onClick={() => setRevealed(false)}
        className="ml-1 rounded px-0.5 text-[11px] text-ink-secondary hover:text-ink"
      >
        Hide
      </button>
    </span>
  );
}

function ChatMarkdownComponent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="chat-md min-w-0 [&>*+*]:mt-2">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{
          pre({ children }: { children?: ReactNode }) {
            // fenced code arrives as <pre><code class="language-x">…</code></pre>
            const child: any = Array.isArray(children) ? children[0] : children;
            const className: string = child?.props?.className ?? "";
            const lang = /language-([^\s]+)/.exec(className)?.[1] ?? "";
            // children can be a string OR an array of strings/nodes — flatten
            // strings only, so String() never comma-joins an array
            const flat = (n: any): string =>
              typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : (n?.props?.children ? flat(n.props.children) : "");
            const code = flat(child?.props?.children).replace(/\n$/, "");
            return <CodeBlock code={code} lang={lang} streaming={streaming} />;
          },
          img({ src, alt }: { src?: string; alt?: string }) {
            // F5-T2: the shared image surface decides what may load; a path
            // or remote URL in model text is never fetched on sight
            return <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />;
          },
          code({ children }: { children?: ReactNode }) {
            // Adapted from OpenMausBot #1023: a path or identifier can be wider
            // than the bubble, and a token with no break opportunity has nowhere
            // to go but out of it. `.chat-md` (styles.css) already inherits
            // `overflow-wrap: anywhere`; upstream's `break-words` would override
            // that with `break-word`, which does not lower min-content, so a long
            // token in a table cell or a content-sized file-link button would
            // still push out. Inline code, links and file links state `anywhere`
            // themselves so a nearer `break-words` can never downgrade it.
            return (
              <code className="rounded bg-inset px-1 py-px text-[13px] [overflow-wrap:anywhere]">{children}</code>
            );
          },
          a({ href, children }: { href?: string; children?: ReactNode }) {
            const localPath = localFilePath(href);
            if (localPath) return <LocalFileLink filePath={localPath}>{children}</LocalFileLink>;
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="[overflow-wrap:anywhere] text-accent underline decoration-accent/40 hover:decoration-accent"
              >
                {children}
              </a>
            );
          },
          table({ children }: { children?: ReactNode }) {
            return (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13.5px]">{children}</table>
              </div>
            );
          },
          th({ children }: { children?: ReactNode }) {
            return (
              <th className="border-b border-hairline/40 px-2 py-1.5 text-left font-semibold">{children}</th>
            );
          },
          td({ children }: { children?: ReactNode }) {
            return <td className="border-b border-hairline/20 px-2 py-1.5 align-top">{children}</td>;
          },
          ul({ children }: { children?: ReactNode }) {
            return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
          },
          ol({ children }: { children?: ReactNode }) {
            return <ol className="list-decimal space-y-1 pl-5">{children}</ol>;
          },
          h1({ children }: { children?: ReactNode }) {
            return <div className="mt-2 text-[16px] font-semibold">{children}</div>;
          },
          h2({ children }: { children?: ReactNode }) {
            return <div className="mt-2 text-[15.5px] font-semibold">{children}</div>;
          },
          h3({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 font-semibold">{children}</div>;
          },
          h4({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 font-semibold">{children}</div>;
          },
          h5({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 text-[14px] font-semibold">{children}</div>;
          },
          h6({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 text-[13.5px] font-semibold text-ink-secondary">{children}</div>;
          },
          blockquote({ children }: { children?: ReactNode }) {
            return (
              <blockquote className="border-l-2 border-hairline pl-3 text-ink-secondary">{children}</blockquote>
            );
          },
          del({ children }: { children?: ReactNode }) {
            return <Spoiler>{children}</Spoiler>;
          },
          hr() {
            return <hr className="border-hairline/40" />;
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export const ChatMarkdown = memo(ChatMarkdownComponent);
