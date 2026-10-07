// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The hard floor on the built-in browser (T39, spec D8 and 2.5). The Electron panel browser, the unified browser and
// the headless engine all drive one page the owner can see, and none of them runs the extension's fact collector.
// This module builds the same FloorFacts from what these paths do have (the accessibility snapshot the model was
// given, and a targeted read of one element), runs the shared classifier (server/browser-floor.ts) and, on a floor,
// returns the same plain "YOUR TURN:" text the extension path returns, so the action is never sent. Unsure is floor.
// The result is plain text in the tool result, so every engine reads it the same way.
import { classifyFloor, type FloorFacts, type FloorResult } from "./browser-floor.ts";
import { FLOOR_OWNER_PHRASE } from "../shared/browser-floor-signatures.ts";

export interface BuiltinElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
}
export interface BuiltinPageInput {
  url?: string;
  title?: string;
  elements?: BuiltinElement[];
  yaml?: string | null;
}
export interface BuiltinTarget {
  ref?: string;
  /** A CSS selector or a ref spelled the engine's way (@e5, e5). */
  selector?: string;
  key?: string;
  text?: string;
}
/** Reads ONE element by selector (outerHTML of that element only). Never the page. */
export type ReadElementHtml = (selector: string) => Promise<string>;

const CAP = 300;
const SNIPPET_CAP = 1000;
const REF = /^@?(?:ref=)?([A-Za-z]{0,2}\d+)$/;
const YAML_LINE = /^\s*-\s*([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?([^\n]*?)\[ref=@?([A-Za-z]{0,2}\d+)\]/;

const PASSWORD = /pass(?:word|code)|passwd/i;
const ONE_TIME = /one[ -]?time|verification code|security code|\botp\b|2fa|authenticator/i;
const CARD = /card (?:number|no)|\bcvv\b|\bcvc\b|security code|expir|name on card/i;
const CURRENCY = /[$€£¥]\s?\d|\d\s?(?:USD|EUR|GBP)\b/;

const ROLE_TAG: Record<string, string> = { button: "button", link: "a", textbox: "input", searchbox: "input", checkbox: "input", radio: "input", combobox: "select", listbox: "select", switch: "input", menuitem: "button", tab: "button" };
const ACTION_OPERATION: Record<string, string> = {
  click: "click", dblclick: "dblclick", check: "check", uncheck: "uncheck", fill: "fill", type: "type", select: "select",
  press: "press", keydown: "press", keyup: "press", keyboard_type: "keyboard_type", keyboard_insert_text: "insert_text",
  focus: "focus", drag: "click",
};

export const normalizeRef = (value: string): string | undefined => REF.exec(value.trim())?.[1];
const clip = (value: string | undefined, max: number) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Parse a snapshot (yaml text or an element list) into ordered elements. */
export function parseSnapshot(page: BuiltinPageInput): BuiltinElement[] {
  if (page.yaml != null) {
    const out: BuiltinElement[] = [];
    for (const line of page.yaml.split("\n")) {
      const m = YAML_LINE.exec(line);
      if (m) out.push({ ref: m[4], role: m[1].toLowerCase(), name: (m[2] ?? "").replace(/\\(.)/g, "$1"), checked: /\[checked(?:=true)?\]/.test(m[3]) ? true : undefined, disabled: /\[disabled\]/.test(m[3]) || undefined });
    }
    return out;
  }
  return (page.elements ?? []).map((e) => ({ ...e, ref: normalizeRef(e.ref) ?? e.ref, role: String(e.role ?? "").toLowerCase() }));
}

function attr(html: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(html);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** Facts from the opening tag and text of one element's markup. Bounded; the rest of the page is never read. */
export function factsFromElementHtml(html: string, operation: string): FloorFacts {
  const source = html.slice(0, 4000);
  const open = /^\s*<([a-zA-Z][\w-]*)([^>]*)>/.exec(source);
  if (!open) return { operation, factsFailed: true };
  const tag = open[1].toLowerCase();
  const tail = ` ${open[2]}`;
  const text = clip(source.replace(/<[^>]*>/g, " "), CAP);
  const type = attr(tail, "type")?.toLowerCase();
  const name = clip(attr(tail, "aria-label") ?? text ?? "", CAP) || clip(attr(tail, "placeholder") ?? attr(tail, "title") ?? attr(tail, "alt"), CAP);
  const facts: FloorFacts = {
    operation, tag, type, role: attr(tail, "role"), name, text,
    ariaLabel: attr(tail, "aria-label"), placeholder: attr(tail, "placeholder"), title: attr(tail, "title"), alt: attr(tail, "alt"),
    fieldName: [attr(tail, "id"), attr(tail, "name")].filter(Boolean).join(" ") || undefined,
    autocomplete: attr(tail, "autocomplete"),
  };
  if (tag === "button" || (tag === "input" && ["submit", "button", "image"].includes(type ?? ""))) facts.buttonValue = attr(tail, "value");
  if ((tag === "button" && (type === undefined || type === "submit")) || (tag === "input" && ["submit", "image"].includes(type ?? ""))) facts.submits = true;
  return facts;
}

export function floorRefusalText(result: FloorResult): string {
  const what = result.floor ? FLOOR_OWNER_PHRASE[result.floor] : "this step";
  return `YOUR TURN: This step needs you in person (${what}). ${result.reason} Nothing was done. Take this step yourself in the browser, then tell me to carry on.`;
}

/** Remembers the last snapshot the model saw and the element it last acted on, and decides each step against them. */
export class BuiltinFloorGate {
  private elements: BuiltinElement[] = [];
  private url = "";
  private title = "";
  private focus: string | undefined;

  remember(page: BuiltinPageInput): void {
    const parsed = parseSnapshot(page);
    // An action result with no element list does not replace what the model last saw.
    if (!parsed.length && page.yaml == null && !page.elements) return;
    this.elements = parsed;
    if (page.url !== undefined) this.url = page.url;
    if (page.title !== undefined) this.title = page.title;
    if (!this.elements.some((e) => e.ref === this.focus)) this.focus = undefined;
  }
  /** The text of a tool result, for engines whose snapshot arrives as MCP content. */
  rememberToolResult(name: string, result: unknown): void {
    if (name !== "agent_browser_snapshot") return;
    const content = (result as { content?: unknown })?.content;
    if (!Array.isArray(content)) return;
    const yaml = content.map((c) => (c && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n");
    this.remember({ yaml });
  }
  noteFocus(ref: string | undefined): void { if (ref) this.focus = normalizeRef(ref) ?? ref; }

  private pageFacts(): Pick<FloorFacts, "form" | "page" | "snippets"> {
    const names = this.elements.map((e) => e.name);
    const joined = clip(names.join(" | "), SNIPPET_CAP);
    let urlPath: string | undefined;
    try { urlPath = new URL(this.url).pathname; } catch { urlPath = undefined; }
    const hasCurrencyAmount = names.some((n) => CURRENCY.test(n));
    return {
      form: {
        hasPasswordField: names.some((n) => PASSWORD.test(n)) || undefined,
        hasOneTimeCodeField: names.some((n) => ONE_TIME.test(n)) || undefined,
        hasCardFields: names.some((n) => CARD.test(n)) || undefined,
        hasCurrencyAmount: hasCurrencyAmount || undefined,
      },
      page: { urlPath, title: this.title || undefined, hasCurrencyAmount: hasCurrencyAmount || undefined },
      snippets: { form: joined },
    };
  }

  /** Facts for one step. A target that cannot be read is factsFailed, which the classifier treats as unsure. */
  async facts(operation: string, target: BuiltinTarget, read?: ReadElementHtml): Promise<FloorFacts> {
    const raw = target.ref ?? target.selector;
    const wanted = raw !== undefined ? raw : this.focus;
    const ref = wanted !== undefined ? normalizeRef(wanted) : undefined;
    const base: FloorFacts = { operation, ...(target.key !== undefined ? { key: target.key } : {}) };
    let own: FloorFacts | undefined;
    if (ref !== undefined) {
      const index = this.elements.findIndex((e) => e.ref === ref);
      if (index >= 0) {
        const e = this.elements[index];
        own = {
          operation, role: e.role, name: clip(e.name, 500), tag: ROLE_TAG[e.role],
          type: e.role === "checkbox" || e.role === "radio" ? e.role : undefined,
          checked: typeof e.checked === "boolean" ? e.checked : undefined,
          snippets: { before: clip(this.elements.slice(Math.max(0, index - 3), index).map((x) => x.name).join(" "), CAP), after: clip(this.elements.slice(index + 1, index + 4).map((x) => x.name).join(" "), CAP) },
        };
      }
    } else if (raw !== undefined && read) {
      own = factsFromElementHtml(await read(raw), operation);
    }
    if (!own) return { ...base, ...this.pageFacts(), factsFailed: true };
    const context = this.pageFacts();
    return { ...base, ...own, form: { ...context.form }, page: context.page, snippets: { ...context.snippets, ...own.snippets, form: context.snippets?.form } };
  }

  async evaluate(operation: string, target: BuiltinTarget = {}, read?: ReadElementHtml): Promise<FloorResult> {
    try {
      const facts = await this.facts(operation, target, read);
      if (target.key !== undefined) facts.key = target.key;
      return classifyFloor(facts);
    } catch {
      // A read that fails is not a reason to let the step through.
      return { floor: operation === "click" ? "verification" : "credentials", rule: "facts-error", reason: "The page could not be read well enough to tell, so the owner takes this step.", unsure: true };
    }
  }

  /** The refusal text when the owner has to take this step, or null when it may go ahead. */
  async check(operation: string, target: BuiltinTarget = {}, read?: ReadElementHtml): Promise<string | null> {
    // This path cannot see where focus really is, so a key that moves it ends what the gate knows about focus:
    // a later type or key with no target is unsure (floor), never classified on the element focus left.
    // Tab only moves focus, as on the extension path, so it is free; arrows can also pick (a radio), so they are judged first.
    const key = operation === "press" ? (target.key ?? "").replace(/\s+/g, "").toLowerCase() : "";
    if (key === "tab" || key === "shift+tab") { this.focus = undefined; return null; }
    const result = await this.evaluate(operation, target, read);
    if (/arrow|^(shift\+)?f6$/.test(key)) this.focus = undefined;
    return result.floor ? floorRefusalText(result) : null;
  }

  /** For the agent-browser tool names used by the unified and headless paths. */
  async guardAgentBrowser(toolName: string, args: Record<string, unknown>, read?: ReadElementHtml): Promise<string | null> {
    const operation = ACTION_OPERATION[toolName.replace(/^agent_browser_/, "")];
    if (!operation) return null;
    const selector = typeof args.selector === "string" ? args.selector : undefined;
    if (operation === "focus") { this.noteFocus(selector); return null; }
    const stop = await this.check(operation, { selector, key: typeof args.key === "string" ? args.key : undefined, text: typeof args.text === "string" ? args.text : undefined }, read);
    if (stop === null && selector !== undefined) this.noteFocus(selector);
    return stop;
  }
}

/** The result shape a tool call returns when the floor stops it. */
export const floorToolResult = (text: string) => ({ content: [{ type: "text", text }] });

/** Preserve the server's browser refusal in both stdio bridges. Unmarked error
 * bodies can contain page data and never reach the client. Kept outside the
 * executable proxy modules so bundling cannot start a second stdio reader. */
export async function readBrowserRefusal(response: Response): Promise<{ code: string; text: string } | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 4096) { await reader.cancel(); return undefined; }
      chunks.push(chunk.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: unknown; code?: unknown };
    // An uncertain effect is never replayed based on raw backend details.
    if (body.code === "uncertain" || body.code === "browser_extension_uncertain") return { code: body.code, text: "The browser step may have happened. Ask the owner to check the page before continuing. Do not repeat this step." };
    return typeof body.code === "string" && /^browser_[a-z0-9_]{1,128}$/.test(body.code) && typeof body.error === "string" ? { code: body.code, text: body.error } : undefined;
  } catch { return undefined; }
  finally { reader.releaseLock(); }
}

/**
 * L11a: is this document one the owner must use directly? The sensitive-field question is asked in an isolated
 * world (BROWSER_DOCUMENT_GUARD_SOURCE), and a page it marks protected is answered without reading the DOM. A page
 * it calls clear still needs one structural check: a closed shadow root can hang off a custom element or off a
 * plain div, span, section and the like, no page function can see it, and nothing on this path checks the target
 * later. Only the browser's own tree (pierce) shows it, so that read stays, and only for pages that look clear
 * (Opus Batch 2 review: the custom-element-only host list let a closed root on a div through). Never clear on doubt.
 */
export async function protectedDocumentTargeted(
  send: (method: string, params?: Record<string, unknown>) => Promise<any>,
  guardSource: string, worldName: string, armed = true,
): Promise<boolean> {
  const tree = await send("Page.getFrameTree");
  let protectedDocument = Boolean(tree.frameTree.childFrames?.length);
  const world = await send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName });
  const result = await send("Runtime.evaluate", { expression: `${guardSource}; globalThis.__murageGuard.enable(${armed}); globalThis.__murageGuard()`, contextId: world.executionContextId, returnByValue: true });
  if (result.exceptionDetails || result.result?.type !== "boolean") throw new Error("Browser document guard could not inspect the page");
  if (result.result.value) protectedDocument = true;
  if (protectedDocument) return true;
  try {
    const dom = await send("DOM.getDocument", { depth: -1, pierce: true });
    const hiddenRoot = (node: any): boolean => node?.shadowRootType === "closed" || (node?.shadowRoots ?? []).some(hiddenRoot) || (node?.children ?? []).some(hiddenRoot);
    if (!dom?.root || hiddenRoot(dom.root)) return true;
  } catch {
    return true;
  }
  return false;
}
