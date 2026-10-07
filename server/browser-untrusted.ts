// SPDX-License-Identifier: AGPL-3.0-or-later
// Page text is data, never instructions. Everything a web page can influence is
// wrapped here, in one place, before it reaches the model (spec 3.2, 3.3).
import { randomBytes } from "node:crypto";

export type FenceOptions = { origin: string; kind: string };

// NUL, other C0/C1 controls except tab/newline/CR, and every bidi override or isolate.
const STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;

function clean(text: string): string {
  return String(text ?? "").replace(STRIP, "");
}

/** Removes control and bidi characters, then makes every marker shape impossible. */
function escapeMarkers(text: string): string {
  return clean(text).replace(/<</g, "‹‹").replace(/>>/g, "››");
}

function attr(value: string, fallback: string): string {
  const v = clean(value).replace(/[\s<>]/g, "");
  return v || fallback;
}

export function fencePageText(text: string, { origin, kind }: FenceOptions): string {
  const id = randomBytes(8).toString("hex");
  return `<<page-content id=${id} origin=${attr(origin, "unknown")} kind=${attr(kind, "text")}>>\n${escapeMarkers(text)}\n<<end page-content id=${id}>>`;
}

type ToolItem = {
  type?: string;
  text?: string;
  /** Item is a sentence Murage wrote itself: never fenced. */
  murage?: boolean;
  /** Leading Murage sentence(s) on an item whose `text` is page-derived. */
  murageLead?: string;
  origin?: string;
  kind?: string;
  [key: string]: unknown;
};
type ToolResult = { content?: ToolItem[]; [key: string]: unknown };

/**
 * Fences each page-derived text item of an MCP tool result. Only an explicit
 * `murage: true` flag (or `murageLead`) exempts text: a page that begins its
 * text with "YOUR TURN:" is still fenced. Returns a new object.
 */
export function fenceToolResult<T extends ToolResult>(output: T, kinds: string | Array<string | undefined>): T {
  if (!output || typeof output !== "object" || !Array.isArray(output.content)) return output;
  const content = output.content.map((item, index) => {
    if (!item || typeof item !== "object" || item.murage === true) return item;
    const kind = item.kind ?? (Array.isArray(kinds) ? (kinds[index] ?? kinds[kinds.length - 1]) : kinds) ?? "text";
    const origin = item.origin ?? "unknown";
    const { murageLead, ...rest } = item;
    let next: ToolItem = rest;
    // Fail closed: any item that carries text is page-derived unless Murage flagged it. Only binary media
    // (image, audio) carries no text to fence.
    if (typeof item.text === "string") {
      const fenced = fencePageText(item.text, { origin, kind });
      next = { ...next, text: typeof murageLead === "string" && murageLead ? `${clean(murageLead)}\n${fenced}` : fenced };
    }
    const resource = item.resource as { text?: unknown } | undefined;
    if (resource && typeof resource === "object" && typeof resource.text === "string") {
      next = { ...next, resource: { ...resource, text: fencePageText(resource.text, { origin, kind }) } };
    }
    return next === rest && murageLead === undefined ? item : next;
  });
  return { ...output, content };
}

export type SensitiveRef = {
  ref: string;
  /** password, card, code, id, or anything else (reads as "sensitive field"). */
  kind?: string;
  /** Optional known value, scrubbed wherever else it appears in the text. */
  value?: string;
};

const KIND_LABEL: Record<string, string> = { password: "password field", card: "card field", code: "code field", id: "ID field" };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces the values of sensitive fields in snapshot text; the field and its ref stay visible. */
export function maskSensitiveValues(snapshotText: string, sensitiveRefs: SensitiveRef[]): string {
  if (!sensitiveRefs?.length) return snapshotText;
  const byRef = new Map(sensitiveRefs.map((r) => [r.ref, r]));
  const label = (r: SensitiveRef) => `[hidden: ${KIND_LABEL[r.kind ?? ""] ?? "sensitive field"}]`;
  const lines = snapshotText.split("\n").map((line) => {
    const m = /\[ref=([^\]\s]+)\]/.exec(line);
    const hit = m ? byRef.get(m[1]!) : undefined;
    if (!hit) return line;
    // Quoted values end at their closing quote; an unquoted value runs to the next [ref=...] or the end of
    // the line, so a value with spaces is hidden whole, never only its first word.
    return line.replace(/\bvalue=(?:"(?:[^"\\]|\\.)*"|.*?(?=\s\[ref=|$))/g, `value=${label(hit)}`);
  });
  let out = lines.join("\n");
  for (const r of sensitiveRefs) {
    if (r.value && r.value.length >= 3) out = out.replace(new RegExp(escapeRe(r.value), "g"), label(r));
  }
  return out;
}

/** "From the page:" collapsed-block data for cards: first four lines, then the rest. */
export function cardPageBlock(text: string): { preview: string; rest: string; hiddenLines: number } {
  const lines = clean(text).split("\n");
  return { preview: lines.slice(0, 4).join("\n"), rest: lines.slice(4).join("\n"), hiddenLines: Math.max(0, lines.length - 4) };
}
