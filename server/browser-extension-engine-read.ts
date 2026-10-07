// SPDX-License-Identifier: AGPL-3.0-or-later
// Read transformation behavior adapted from vercel-labs/agent-browser v0.36.0
// cli/src/read.rs, commit eb05921bad874cd2a1b4fa5d1149f1ed26576cae (Apache-2.0).
// Copyright Vercel, Inc. Apache-2.0 license retained in LICENSES/Apache-2.0.txt.
// Modified transport: every destination requires admission; credentials are never
// inherited, and oversized/protected responses are refused rather than truncated.
import { parse } from "parse5";
import { fencePageText } from "./browser-untrusted.ts";
import { capReadText, READ_BUDGET } from "./browser-extension-snapshot.ts";
import { looksLikeSecretName } from "../shared/browser-secret-classifier.ts";
import { redactMediaType, redactPageOutput, redactUrlForOutput, sanitizeRawHtml } from "./browser-output-redaction.ts";

type Node = { nodeName: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[]; content?: Node };
export type EngineReadOptions = { url?: string; raw?: boolean; requireMd?: boolean; llms?: "index" | "full"; outline?: boolean; filter?: string; readTimeoutMs?: number };
export interface EngineReadContext {
  currentUrl: string;
  activeHtml: () => Promise<string>;
  authorize: () => boolean;
  admitUrl: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  /** Seam for the core lane: when set, page text in the result is capped at 20,000 characters and fenced (T24). */
  fenceOrigin?: string;
}
class RefusedRead extends Error {}
const BODY_LIMIT = 2 * 1024 * 1024;
const baseType = (type: string) => type.split(";")[0].trim().toLowerCase();
const markdown = (type: string) => ["text/markdown", "text/x-markdown", "application/markdown"].includes(baseType(type));
const htmlType = (type: string) => ["text/html", "application/xhtml+xml"].includes(baseType(type));
const asciiLower = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
const expectedMarkdown = (type: string) => new Error(`Expected text/markdown, got ${redactMediaType(type.split(";")[0].trim()) || "unknown content type"}`);

// A field is private by what it says it is, and by what its label says: a <label for>, an ancestor
// <label>, aria-labelledby and the visible text they point at all count, as does a revealed password
// (type=text with a password-looking name, id, autocomplete or label).
const FIELD_TAGS = new Set(["input", "textarea", "select"]);
function textOf(node: Node): string {
  if (node.nodeName === "#text") return node.value ?? "";
  if (["script", "style"].includes(node.tagName ?? "")) return "";
  return [...(node.childNodes ?? []), ...(node.content ? [node.content] : [])].map(textOf).join(" ");
}
export function inspectReadHtml(html: string): Node {
  if (Buffer.byteLength(html) > BODY_LIMIT) throw new RefusedRead("The response is too large to inspect.");
  // HTML5 parsing decodes entities in attributes and handles malformed markup,
  // foreign content and template contents without executing scripts or loading URLs.
  const document = parse(html) as unknown as Node;
  // One walk collects every element by id, every label by the id it points at, and every field with the
  // text of the labels around it. Frames and shadow templates are not refused: their content is not in the text.
  const pending = [{ node: document, depth: 0, above: "" }];
  const byId = new Map<string, Node>(), labelFor = new Map<string, string[]>(), fields: { node: Node; above: string }[] = [];
  let count = 0;
  while (pending.length) {
    const { node, depth, above } = pending.pop()!;
    if (++count > 100000 || depth > 512) throw new RefusedRead("The response is too complex to inspect.");
    const tag = (node.tagName ?? "").toLowerCase();
    const attrs = Object.fromEntries((node.attrs ?? []).map(a => [a.name.toLowerCase(), a.value]));
    if (attrs.id && !byId.has(attrs.id)) byId.set(attrs.id, node);
    let inside = above;
    if (tag === "label") { const own = textOf(node); inside = `${above} ${own}`; if (attrs.for) labelFor.set(attrs.for, [...(labelFor.get(attrs.for) ?? []), own]); }
    if (FIELD_TAGS.has(tag) || Object.hasOwn(attrs, "contenteditable") || attrs.role === "textbox") fields.push({ node, above });
    for (const child of node.childNodes ?? []) pending.push({ node: child, depth: depth + 1, above: inside });
    if (node.content) pending.push({ node: node.content, depth: depth + 1, above: inside });
  }
  for (const { node, above } of fields) {
    const attrs = Object.fromEntries((node.attrs ?? []).map(a => [a.name.toLowerCase(), a.value]));
    const named = [attrs.type, attrs.name, attrs.id, attrs.autocomplete, attrs["aria-label"], attrs.placeholder, attrs.title, above];
    if (attrs.id) named.push(...(labelFor.get(attrs.id) ?? []));
    if (attrs["aria-labelledby"]) for (const id of attrs["aria-labelledby"].split(/\s+/)) { const target = byId.get(id); if (target) named.push(textOf(target)); }
    if (looksLikeSecretName(named.join(" "))) throw new RefusedRead("This response contains protected fields. Take over to continue.");
  }
  return document;
}

function normalize(text: string) {
  let fence = false, blank = false;
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = fence ? raw.trimEnd() : raw.trim().split(/\s+/).join(" ");
    if (line.trim() === "```") fence = !fence;
    if (!line.trim()) { if (lines.length && !blank) lines.push(""); blank = true; }
    else { blank = false; lines.push(line); }
  }
  return lines.join("\n").trim();
}
export function readHtmlToText(document: Node): string {
  const blocks = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "blockquote", "table", "tr", "ul", "ol"]);
  const walk = (node: Node): string => {
    const tag = node.tagName ?? "";
    if (["head", "script", "style", "noscript", "svg", "template"].includes(tag)) return "";
    if (node.nodeName === "#text") return node.value ?? "";
    const children = (node.childNodes ?? []).map(walk).join("");
    if (/^h[1-6]$/.test(tag)) return "\n\n" + "#".repeat(Number(tag[1])) + " " + children + "\n\n";
    if (tag === "br") return "\n";
    if (tag === "li") return "\n- " + children + "\n\n";
    if (tag === "pre") return "\n\n```\n" + children + "\n```\n\n";
    return blocks.has(tag) ? "\n\n" + children + "\n\n" : children;
  };
  return normalize(walk(document));
}
function heading(line: string) {
  const match = /^\s*(#{1,6})(?:\s+|$)(.*?)\s*#*\s*$/.exec(line);
  return match && match[2] ? { level: match[1].length, title: match[2] } : null;
}
function filterMarkdownSections(text: string, filter: string, empty: string) {
  const needle = asciiLower(filter), sections: string[] = [];
  let current: string[] = [];
  const flush = () => { const value = current.join("\n").trim(); if (value && asciiLower(value).includes(needle)) sections.push(value); current = []; };
  for (const line of text.split("\n")) { if (line.trimStart().startsWith("#") && current.join("\n").trim()) flush(); current.push(line); }
  flush();
  return sections.length ? sections.join("\n\n") : text.split("\n").filter(line => asciiLower(line).includes(needle)).join("\n") || empty;
}
function filterPageSections(text: string, filter: string) {
  const needle = asciiLower(filter), lines = text.split("\n");
  const heads = lines.flatMap((line, index) => { const h = heading(line); return h ? [{ ...h, index }] : []; });
  const found: string[] = [];
  let until = 0;
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (h.index < until || !asciiLower(h.title).includes(needle)) continue;
    let end = lines.length;
    for (let j = i + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].index; break; }
    found.push(lines.slice(h.index, end).join("\n").trim()); until = end;
  }
  if (found.length) return found.join("\n\n");
  const sections = filterMarkdownSections(text, filter, "No matching page sections");
  // A body match in one huge section must not return the same first page forever.
  // Keep section context when it fits; otherwise return the matching lines before capping.
  return sections.length <= READ_BUDGET ? sections : lines.filter(line => asciiLower(line).includes(needle)).join("\n") || "No matching page sections";
}
function transform(text: string, url: string, options: EngineReadOptions) {
  if (options.outline) {
    const heads = text.split("\n").flatMap(line => {
      const h = heading(line);
      return h && (options.filter === undefined || asciiLower(h.title).includes(asciiLower(options.filter))) ? [h] : [];
    });
    return heads.length ? `# Outline\n\nSource: ${url}\n` + heads.map(h => "\n" + "  ".repeat(h.level - 1) + "- " + h.title).join("")
      : options.filter !== undefined ? "No matching headings" : "No headings found";
  }
  return options.filter !== undefined ? filterPageSections(text, options.filter) : text;
}
function links(text: string, base: string) {
  const found: { title: string; url: string }[] = [], seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!/^\s*(?:[-*+] |\d+[.)] )/.test(line)) continue;
    for (const match of line.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)) {
      try {
        const title = match[1].trim(), href = match[2].trim().split(/\s+/)[0].replace(/^<+|>+$/g, "");
        if (!title || !href) continue;
        const url = new URL(href, base).href, key = asciiLower(title) + "\0" + url;
        if (!seen.has(key)) { seen.add(key); found.push({ title, url }); }
      } catch { /* Malformed links have no usable destination. */ }
    }
  }
  return found;
}
function candidates(url: string, name: string) {
  const u = new URL(url), parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length === 1 && !parts[0]) parts.pop();
  const out: string[] = [];
  for (let i = parts.length; i >= 0; i--) {
    const next = new URL(u); next.pathname = "/" + [...parts.slice(0, i), name].join("/"); next.search = ""; next.hash = ""; out.push(next.href);
  }
  return [...new Set(out)];
}
function docPath(url: URL) { return (url.pathname.replace(/\/+$/, "") || "/").replace(/\.md$/, "").replace(/\/index$/, "") || "/"; }
function linkedDocument(text: string, base: string, target: string) {
  const possible = links(text, base), requested = new URL(target);
  const exact = possible.find(link => { const u = new URL(link.url); return u.origin === requested.origin && docPath(u) === docPath(requested); });
  if (exact) return exact;
  const segment = asciiLower(docPath(requested).split("/").filter(Boolean).at(-1) ?? "");
  if (!segment) return undefined;
  const matches = possible.filter(link => {
    const u = new URL(link.url);
    return u.origin === requested.origin && (asciiLower(docPath(u).split("/").filter(Boolean).at(-1) ?? "") === segment || asciiLower(link.title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === segment);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export async function readWithBrowserAuthority(options: EngineReadOptions, context: EngineReadContext) {
  const timeout = options.readTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) throw new RefusedRead("Read timeout must be between 1 and 60000 milliseconds.");
  const deadline = Date.now() + timeout, controller = new AbortController();
  const timeoutError = new RefusedRead("Browser read timed out.");
  let bytes = 0, requests = 0;
  const valid = () => {
    if (!context.authorize()) throw new RefusedRead("Browser authority changed during reading.");
    if (controller.signal.aborted || Date.now() >= deadline) throw timeoutError;
  };
  // The one deadline also covers owner admission, activeHtml, fetch headers and
  // stalled body streams, including test/custom transports which ignore signal.
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    valid();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(timeoutError); controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try { const value = await Promise.race([operation(), aborted]); valid(); return value; }
    finally { controller.signal.removeEventListener("abort", onAbort); }
  };
  const timer = setTimeout(() => controller.abort(), timeout);
  const allow = async (value: string) => {
    valid();
    let url: URL;
    try { url = new URL(value); } catch { throw new RefusedRead("Browser read URL refused."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new RefusedRead("Browser read URL refused.");
    try { await bounded(() => context.admitUrl(url.href)); }
    catch (error) { if (error instanceof RefusedRead) throw error; throw new RefusedRead("Browser read destination was not approved."); }
    valid(); return url;
  };
  const fetchResource = async (value: string) => {
    let url = await allow(value);
    url.hash = "";
    for (let redirects = 0; redirects <= 10; redirects++) {
      valid();
      if (++requests > 32) throw new RefusedRead("Browser read request limit reached.");
      const response = await bounded(() => (context.fetch ?? fetch)(url.href, {
        method: "GET", credentials: "omit", referrerPolicy: "no-referrer", redirect: "manual", signal: controller.signal,
        headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.7, */*;q=0.1", "User-Agent": "agent-browser/0.36.0 read" },
      }));
      if (response.redirected || (response.url && response.url !== url.href)) {
        void response.body?.cancel().catch(() => {});
        throw new RefusedRead("Browser read transport followed an unmediated redirect.");
      }
      const location = response.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        void response.body?.cancel().catch(() => {});
        if (redirects === 10) throw new RefusedRead("Browser read redirect limit reached.");
        url = await allow(new URL(location, url).href); url.hash = ""; continue;
      }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
      try {
        if (reader) for (;;) {
          const chunk = await bounded(() => reader.read());
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > BODY_LIMIT) throw new RefusedRead("Browser read exceeds the inspected response limit.");
          chunks.push(chunk.value);
        }
      } catch (error) { void reader?.cancel().catch(() => {}); throw error; }
      finally { reader?.releaseLock(); }
      const body = new TextDecoder().decode(Buffer.concat(chunks));
      const parsed = inspectReadHtml(body); valid();
      return { body, parsed, finalUrl: url.href, status: response.status, contentType: response.headers.get("content-type") ?? "", ok: response.ok };
    }
    throw new RefusedRead("Browser read redirect limit reached.");
  };
  try {
    const active = !options.url && !options.llms && !options.requireMd;
    const rawTarget = options.url ?? context.currentUrl;
    // Match upstream's https shorthand for fetched URLs; an active document's
    // URL remains exact. Admission sees any requested fragment before stripping.
    const requested = active || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget.trim()) ? rawTarget.trim() : `https://${rawTarget.trim()}`;
    const admitted = await allow(requested);
    if (!active) admitted.hash = "";
    const target = admitted.href;
    const result = (value: { finalUrl: string; contentType: string; status?: number }, source: string, content: string, pageTransform = true) => {
      // M9: the text belongs to the document that was fetched (its final origin), not to the tab the bot happens to be on.
      const fetchedOrigin = (() => { try { return new URL(value.finalUrl).origin; } catch { return undefined; } })();
      const fenceOrigin = context.fenceOrigin === undefined ? undefined : fetchedOrigin ?? context.fenceOrigin;
      // Whatever the mode, the text that leaves here has passed the page-output redaction (cards, codes, SSNs, labelled secrets, URL paths).
      const transformed = redactPageOutput(pageTransform ? transform(content, value.finalUrl, options) : content);
      const capped = context.fenceOrigin === undefined ? { text: transformed, truncated: false } : capReadText(transformed);
      const output = fenceOrigin === undefined ? capped.text : fencePageText(capped.text, { origin: fenceOrigin, kind: "read" });
      const suffix = pageTransform ? options.outline ? "-outline" : options.filter !== undefined ? "-filtered" : "" : "";
      valid();
      // Never spread an internal fetch object: it contains the raw response and
      // parse5 parent-linked tree, neither of which belongs in observations.
      return { content: [{ type: "text", text: output, ...(fenceOrigin === undefined ? {} : { origin: fenceOrigin }) }], structuredContent: {
        url: redactUrlForOutput(target), finalUrl: redactUrlForOutput(value.finalUrl), ...(value.status === undefined ? {} : { status: value.status }),
        contentType: redactMediaType(value.contentType), source: source + suffix, truncated: capped.truncated, content: output,
      } };
    };
    if (active) {
      const html = await bounded(context.activeHtml), parsed = inspectReadHtml(html);
      return result({ finalUrl: target, contentType: "text/html" }, options.raw ? "active-tab-raw" : "active-tab-html", options.raw ? sanitizeRawHtml(html) : readHtmlToText(parsed));
    }
    const llmsFile = async (name: string, optional = false) => {
      let lastStatus: number | undefined;
      for (const candidate of candidates(target, name)) {
        const fetched = await fetchResource(candidate); lastStatus = fetched.status;
        if (fetched.ok && !htmlType(fetched.contentType)) {
          if (!optional && options.requireMd && baseType(fetched.contentType) !== "text/markdown") throw expectedMarkdown(fetched.contentType);
          return { fetched, candidate };
        }
      }
      if (optional) return null;
      throw new Error(lastStatus === undefined ? `${name} not found` : `${name} failed with HTTP ${lastStatus}`);
    };
    if (options.llms) {
      const { fetched } = (await llmsFile(options.llms === "index" ? "llms.txt" : "llms-full.txt"))!;
      let content = fetched.body;
      if (options.llms === "index") {
        let found = links(content, fetched.finalUrl);
        if (options.filter !== undefined) { const needle = asciiLower(options.filter); found = found.filter(link => asciiLower(link.title).includes(needle) || asciiLower(link.url).includes(needle)); }
        content = found.length ? `# llms.txt\n\nSource: ${fetched.finalUrl}\n` + found.map(link => `\n- [${link.title}](${link.url})`).join("")
          : options.filter !== undefined ? "No matching llms.txt links" : normalize(content);
      } else if (options.filter !== undefined) content = filterMarkdownSections(content, options.filter, "No matching llms-full.txt sections");
      // llms modes own their output view: upstream ignores raw/outline here.
      return result(fetched, "llms-" + options.llms, content, false);
    }
    const contentFrom = (fetched: Awaited<ReturnType<typeof fetchResource>>) => {
      if (options.requireMd && baseType(fetched.contentType) !== "text/markdown") throw expectedMarkdown(fetched.contentType);
      if (options.raw) return { source: "raw", content: /<[a-zA-Z!]/.test(fetched.body) ? sanitizeRawHtml(fetched.body) : fetched.body };
      if (markdown(fetched.contentType)) return { source: "accept-markdown", content: fetched.body };
      if (baseType(fetched.contentType) === "text/plain") return { source: "text", content: fetched.body };
      if (htmlType(fetched.contentType)) return { source: "html-fallback", content: readHtmlToText(fetched.parsed) };
      return { source: "raw", content: /<[a-zA-Z!]/.test(fetched.body) ? sanitizeRawHtml(fetched.body) : fetched.body };
    };
    const primary = await fetchResource(target);
    if (primary.ok && (options.raw || baseType(primary.contentType) === "text/markdown" || (!options.requireMd && markdown(primary.contentType)))) {
      const content = contentFrom(primary); return result(primary, content.source, content.content);
    }
    if (!options.raw && baseType(primary.contentType) !== "text/markdown") {
      const md = new URL(target);
      if (!md.pathname.endsWith(".md")) {
        md.pathname = (md.pathname === "/" ? "/index" : md.pathname.replace(/\/+$/, "")) + ".md";
        try {
          const fetched = await fetchResource(md.href);
          if (fetched.ok && (options.requireMd ? baseType(fetched.contentType) === "text/markdown" : markdown(fetched.contentType) || baseType(fetched.contentType) === "text/plain")) return result(fetched, "path-markdown", fetched.body);
        } catch (error) { if (error instanceof RefusedRead) throw error; valid(); }
      }
    }
    if (primary.ok && !options.requireMd && baseType(primary.contentType) === "text/plain") {
      const content = contentFrom(primary); return result(primary, content.source, content.content);
    }
    if (!options.raw) {
      try {
        const index = await llmsFile("llms.txt", true);
        // Upstream resolves automatic fallback links against the candidate URL;
        // explicit --llms index uses the fetched final URL instead.
        const link = index && linkedDocument(index.fetched.body, index.candidate, target);
        if (link) {
          const fetched = await fetchResource(link.url);
          if (fetched.ok && (!options.requireMd || baseType(fetched.contentType) === "text/markdown")) return result(fetched, "llms-link", htmlType(fetched.contentType) ? readHtmlToText(fetched.parsed) : fetched.body);
        }
      } catch (error) { if (error instanceof RefusedRead) throw error; valid(); }
    }
    if (!primary.ok) throw new Error(`Read failed with HTTP ${primary.status}`);
    const content = contentFrom(primary); return result(primary, content.source, content.content);
  } finally { clearTimeout(timer); controller.abort(); }
}
