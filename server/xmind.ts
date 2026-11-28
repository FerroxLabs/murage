// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour from OpenMausBot PR #5265, implemented independently. Only
// content.json/content.xml are read, in memory. No entry reaches the disk.
import * as yauzl from "yauzl";
import { crc32 } from "node:zlib";
import { redactSecretsInText } from "./redact.ts";

export const XMIND_MAX_BYTES = 8 * 1024 * 1024;
const EXPANDED_MAX = 16 * 1024 * 1024;
const ENTRIES_MAX = 256;
const TOPICS_MAX = 10_000;
const DEPTH_MAX = 64;
const OUTLINE_MAX = 2 * 1024 * 1024;
const invalid = () => Object.assign(new Error("That mind map could not be read. Use a smaller XMind file or export it as Markdown."), { status: 400 });
type Topic = { title?: unknown; children?: { attached?: unknown; detached?: unknown } };
type Sheet = { title?: unknown; rootTopic?: unknown };

function plain(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalid();
  // Reject before doing any title processing when even the raw title alone
  // exceeds the whole outline's budget. Refusals never echo its contents.
  if (Buffer.byteLength(value) > OUTLINE_MAX) throw invalid();
  // Mask the whole title before escaping markup or shortening anything.
  return redactSecretsInText(value).replace(/[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, " ").trim()
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\\`*_{}\[\]()!#|~]/g, "\\$&");
}

function outline(sheets: unknown): string {
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > ENTRIES_MAX) throw invalid();
  const lines: string[] = [];
  let length = 0, topics = 0;
  const add = (line: string) => {
    length += Buffer.byteLength(line) + 1;
    if (length > OUTLINE_MAX) throw invalid();
    lines.push(line);
  };
  for (const sheet of sheets as Sheet[]) {
    if (!sheet || typeof sheet !== "object" || !sheet.rootTopic) throw invalid();
    if (lines.length) add("");
    add(`# ${plain(sheet.title)}`.trimEnd()); add("");
    const pending = [{ topic: sheet.rootTopic as Topic, depth: 0 }];
    while (pending.length) {
      const { topic, depth } = pending.pop()!;
      if (!topic || typeof topic !== "object" || Array.isArray(topic) || depth > DEPTH_MAX || ++topics > TOPICS_MAX) throw invalid();
      add(`${"  ".repeat(depth)}- ${plain(topic.title)}`.trimEnd());
      const children = topic.children;
      if (children !== undefined && (!children || typeof children !== "object" || Array.isArray(children))) throw invalid();
      const attached = children?.attached ?? [], detached = children?.detached ?? [];
      if (!Array.isArray(attached) || !Array.isArray(detached) || attached.length + detached.length + pending.length > TOPICS_MAX) throw invalid();
      for (const child of [...attached, ...detached].reverse()) pending.push({ topic: child as Topic, depth: depth + 1 });
    }
  }
  return lines.join("\n") + "\n";
}

/** A small XML reader for the legacy XMind tree. No DTD, custom entities,
 * external resources, or HTML recovery. Structural work and nesting are
 * bounded independently of the ZIP limits. Notes and styles are not output. */
function legacySheets(text: string): Sheet[] {
  type Node = { tag: string; text: string; children: Node[] };
  const root: Node = { tag: "", text: "", children: [] }, stack = [root];
  const token = /<!--[\s\S]*?-->|<\?xml\s[^?]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/gy;
  let at = 0, nodes = 0;
  // XML's supported named and numeric references fit in ten characters.
  // Each ampersand examines at most that many characters; the fallback
  // refuses bare ampersands instead of rescanning an unbounded suffix.
  const decode = (s: string) => s.replace(/&([^&;]{1,10});|&/g, (_, entity: string | undefined) => {
    if (entity === undefined) throw invalid();
    const known: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(known, entity)) return known[entity]!;
    const code = /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw invalid();
    return String.fromCodePoint(code);
  });
  for (let match = token.exec(text); match; match = token.exec(text)) {
    at = token.lastIndex;
    const part = match[0];
    // A comment, declaration or CDATA opener that its own alternative did not close was cut at the next ">" by the generic
    // alternative: the failed scan has already read the rest of the input once, so refuse it here instead of letting every
    // such fragment repeat the scan (quadratic in the content size).
    if (part.startsWith("<!--")) { if (part.length < 7 || !part.endsWith("-->")) throw invalid(); continue; }
    if (part.startsWith("<?xml")) { if (!/^<\?xml\s[^?]*\?>$/.test(part)) throw invalid(); continue; }
    const current = stack.at(-1)!;
    if (part.startsWith("<![CDATA[")) { if (part.length < 12 || !part.endsWith("]]>")) throw invalid(); current.text += part.slice(9, -3); continue; }
    if (!part.startsWith("<")) { current.text += decode(part); continue; }
    if (part.startsWith("</")) {
      if (stack.length === 1 || part !== `</${current.tag}>`) throw invalid();
      stack.pop(); continue;
    }
    const open = /^<([a-zA-Z_][\w:.-]*)(?:\s+[\w:.-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*(\/?)>$/.exec(part);
    if (!open || ++nodes > TOPICS_MAX * 8 || stack.length > DEPTH_MAX * 4) throw invalid();
    const node: Node = { tag: open[1]!, text: "", children: [] };
    current.children.push(node);
    if (!open[2]) stack.push(node);
  }
  if (at !== text.length || stack.length !== 1 || root.children.length !== 1 || root.children[0]!.tag !== "xmap-content") throw invalid();
  const title = (node: Node) => node.children.find(child => child.tag === "title")?.text ?? "";
  const topic = (node: Node, depth: number): Topic => {
    if (depth > DEPTH_MAX) throw invalid();
    const children = node.children.filter(child => child.tag === "children").flatMap(child => child.children)
      .filter(child => child.tag === "topics").flatMap(child => child.children).filter(child => child.tag === "topic");
    return { title: title(node), children: { attached: children.map(child => topic(child, depth + 1)) } };
  };
  return root.children[0]!.children.filter(child => child.tag === "sheet").map(sheet => {
    const first = sheet.children.find(child => child.tag === "topic");
    if (!first) throw invalid();
    return { title: title(sheet), rootTopic: topic(first, 0) };
  });
}

export async function xmindToMarkdown(bytes: Buffer): Promise<string> {
  if (!bytes.length || bytes.length > XMIND_MAX_BYTES) throw invalid();
  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value!)));
    if (zip.entryCount > ENTRIES_MAX) throw invalid();
    const source = zip, content = new Map<string, yauzl.Entry>(), names = new Set<string>();
    await new Promise<void>((resolve, reject) => {
      let expanded = 0;
      source.on("error", reject);
      source.on("end", resolve);
      source.on("entry", (entry: yauzl.Entry) => {
        const name = entry.fileName, parts = name.replace(/\/$/, "").split("/");
        expanded += entry.uncompressedSize;
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (names.has(name) || names.size >= ENTRIES_MAX || name.length > 512 || parts.length > 16 || /[\\:\u0000-\u001f\u007f]/.test(name) || parts.some(part => !part || part === "." || part === "..") || expanded > EXPANDED_MAX || !Number.isSafeInteger(expanded) || entry.isEncrypted() || (mode !== 0 && mode !== 0x8000 && mode !== 0x4000)) { reject(invalid()); return; }
        names.add(name);
        if (name === "content.json" || name === "content.xml") {
          if (entry.uncompressedSize > XMIND_MAX_BYTES) { reject(invalid()); return; }
          content.set(name, entry);
        }
        source.readEntry();
      });
      source.readEntry();
    });
    const entry = content.get("content.json") ?? content.get("content.xml");
    if (!entry) throw invalid();
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => source.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value!)));
    const text = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      stream.on("error", reject);
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > XMIND_MAX_BYTES || size > entry.uncompressedSize) { (stream as import("node:stream").Readable).destroy(invalid()); return; }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
    if (text.length !== entry.uncompressedSize || crc32(text) !== entry.crc32) throw invalid();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(text);
    return outline(entry.fileName.endsWith(".json") ? JSON.parse(decoded) : legacySheets(decoded));
  } catch { throw invalid(); }
  finally { zip?.close(); }
}
