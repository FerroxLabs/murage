// SPDX-License-Identifier: AGPL-3.0-or-later
import { NATIVE_DOM_SOURCE } from "./browser-native-dom.ts";
// Murage for Chrome read layer (spec 6.1). Murage owns the snapshot shape: refs are keyed by
// (frameId:loaderId, backendNodeId), so a ref lives while its node lives and dies on navigation.
// Built only from CDP methods the extension already allows: Accessibility.getFullAXTree, DOM.describeNode,
// DOM.getBoxModel, DOM.resolveNode, Page.getFrameTree, Page.getLayoutMetrics, Runtime.callFunctionOn.
import { looksLikeSecretName, looksLikeSecretValue, normalizeSecretText } from "../shared/browser-secret-classifier.ts";
import { fencePageText, maskSensitiveValues, type SensitiveRef } from "./browser-untrusted.ts";

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<any>;

export const SNAPSHOT_BUDGET = 40_000;
export const READ_BUDGET = 20_000;

const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "slider", "spinbutton", "listbox", "treeitem"]);
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const CONTEXT = new Set(["heading", "StaticText", "text", "img", "image", "paragraph", "listitem", "cell", "columnheader", "rowheader", "dialog", "alertdialog", "alert", "status"]);
const SENSITIVE_NAME = /password|passwd|passcode|one.?time|otp|verification.?code|security.?code|cvv|cvc|card.?number|credit.?card|debit.?card|cc-|iban|routing|sort.?code|account.?number|social.?security|ssn|seed.?phrase|mnemonic|api.?key|secret|access.?token|id.?(card|number|document)|passport/i;

export type SnapNode = { key: string; ref: string; backendNodeId: number; frameLoader: string; role: string; name: string; value?: string; interactive: boolean; ordinal: number; sensitive?: string };
export type Snapshot = { url: string; frameLoader: string; nodes: SnapNode[]; dialogs: string[]; text: string; shown: number; below: number; above: number; budgeted: boolean };

const val = (v: any) => (v && typeof v === "object" && "value" in v ? v.value : v);
const q = (s: string) => `"${String(s).replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 160)}"`;
const label = (n: SnapNode) => `${n.role}${n.name ? " " + q(n.name) : ""}`;

export class ReadLayerError extends Error {
  code: "unknown_ref" | "expired_ref" | "gone_ref";
  constructor(code: "unknown_ref" | "expired_ref" | "gone_ref", message: string) { super(message); this.code = code; }
}

type Raw = { backendNodeId: number; frameLoader: string; role: string; name: string; value?: string; interactive: boolean; ordinal: number };

export class ReadLayer {
  private refs = new Map<string, SnapNode>();
  private byKey = new Map<string, string>();
  private counter = 0;
  private lastLoader = "";
  last?: Snapshot;
  /** Round 10 (R9-02): live values of fields the page holds. A node name or dialog name that carries one is never kept or shown. */
  private secrets: string[] = [];
  private send: CdpSend;
  private opts: { origin: () => string; url: () => string };
  constructor(send: CdpSend, opts: { origin: () => string; url: () => string }) { this.send = send; this.opts = opts; }

  private async frames(): Promise<{ main: string; map: Map<string, string> }> {
    const tree = (await this.send("Page.getFrameTree")).frameTree;
    const map = new Map<string, string>();
    const walk = (t: any) => { map.set(t.frame.id, `${t.frame.id}:${t.frame.loaderId}`); (t.childFrames ?? []).forEach(walk); };
    walk(tree);
    return { main: `${tree.frame.id}:${tree.frame.loaderId}`, map };
  }

  private async axNodes(map: Map<string, string>, main: string): Promise<Raw[]> {
    const { nodes = [] } = await this.send("Accessibility.getFullAXTree", { depth: 48 });
    const seen = new Map<string, number>();
    const out: Raw[] = [];
    for (const n of nodes) {
      if (n.ignored || n.backendDOMNodeId === undefined) continue;
      const role = String(val(n.role) ?? "");
      if (!role || role === "none" || role === "generic" || role === "InlineTextBox" || role === "RootWebArea") continue;
      const interactive = INTERACTIVE.has(role);
      if (!interactive && !CONTEXT.has(role)) continue;
      const name = String(val(n.name) ?? "");
      if (!interactive && !name.trim()) continue;
      const value = val(n.value);
      const sk = `${role}|${name}`;
      const ordinal = seen.get(sk) ?? 0; seen.set(sk, ordinal + 1);
      out.push({ backendNodeId: n.backendDOMNodeId, frameLoader: (n.frameId && map.get(n.frameId)) || main, role, name, ...(value === undefined || value === "" ? {} : { value: String(value) }), interactive, ordinal });
    }
    return out;
  }

  /** A name the page wrote that is a secret value, or carries a field's live value, is replaced before it is stored (and so before any output or diff). */
  private safeName(role: string, name: string): string {
    if (!name) return name;
    if (FIELD_ROLES.has(role) && looksLikeSecretValue(name)) return "[hidden]";
    // Round 10 (R10-06): matched after the classifier's normalisation, so an invisible mark, a full-width digit or a separator inside the copy does not hide it.
    const squash = (t: string) => normalizeSecretText(t).toLowerCase().replace(/[\s._\-,']/g, "");
    const sq = squash(name);
    for (const v of this.secrets) { const s = squash(v); if (s.length >= 3 && sq.includes(s)) return "[hidden]"; }
    return name;
  }

  private async sensitiveKind(n: Raw): Promise<string | undefined> {
    if (!FIELD_ROLES.has(n.role)) return undefined;
    const attrs: Record<string, string> = {};
    try {
      const a: string[] = (await this.send("DOM.describeNode", { backendNodeId: n.backendNodeId })).node?.attributes ?? [];
      for (let i = 0; i + 1 < a.length; i += 2) attrs[a[i]!.toLowerCase()] = a[i + 1]!;
    } catch { /* node gone: the name rules below still apply */ }
    const type = (attrs.type ?? "").toLowerCase(), auto = (attrs.autocomplete ?? "").toLowerCase();
    if (type === "password" || /password/.test(auto)) return "password";
    if (/^cc-|card/.test(auto)) return "card";
    if (/one-time-code/.test(auto)) return "code";
    const hay = `${n.name} ${attrs.name ?? ""} ${attrs.id ?? ""} ${attrs.placeholder ?? ""} ${attrs["aria-label"] ?? ""}`;
    // Round 9 (R8-02): the shared classifier too. A field holding a PIN, a code, an SSN or a card is masked whatever it is called.
    if (n.value && looksLikeSecretValue(n.value)) return "code";
    if (!SENSITIVE_NAME.test(hay) && !looksLikeSecretName(hay)) return undefined;
    if (/card|cc-|cvv|cvc|iban|routing|sort|account/i.test(hay)) return "card";
    if (/otp|one.?time|verification|security.?code/i.test(hay)) return "code";
    if (/ssn|social|passport|id.?(card|number|document)/i.test(hay)) return "id";
    return "password";
  }

  /** Takes a snapshot. A node that lived through an earlier snapshot keeps its ref. */
  async snapshot(): Promise<Snapshot> {
    const { main, map } = await this.frames();
    if (main !== this.lastLoader) { this.refs.clear(); this.byKey.clear(); this.lastLoader = main; }
    const raw = await this.axNodes(map, main);
    // Every field value on the page is known before any name is kept (R9-02).
    this.secrets = raw.filter((r) => r.value && r.value.trim().length >= 3 && FIELD_ROLES.has(r.role)).map((r) => r.value!.trim());
    const nodes: SnapNode[] = [];
    const sensitive: SensitiveRef[] = [];
    for (const r of raw) {
      const key = `${r.frameLoader}:${r.backendNodeId}`;
      let ref = this.byKey.get(key);
      if (!ref) { ref = `e${++this.counter}`; this.byKey.set(key, ref); }
      const node: SnapNode = { key, ref, backendNodeId: r.backendNodeId, frameLoader: r.frameLoader, role: r.role, name: this.safeName(r.role, r.name), ...(r.value === undefined ? {} : { value: r.value }), interactive: r.interactive, ordinal: r.ordinal };
      if (r.interactive) {
        const kind = await this.sensitiveKind(r);
        if (kind) { node.sensitive = kind; sensitive.push({ ref, kind, ...(r.value ? { value: r.value } : {}) }); }
      }
      this.refs.set(ref, node);
      nodes.push(node);
    }
    const line = (n: SnapNode) => `- ${label(n)}${n.value !== undefined ? ` value=${q(n.value)}` : ""}${n.interactive ? ` [ref=${n.ref}]` : ""}`;
    let shown = nodes, below = 0, above = 0, budgeted = false;
    let text = nodes.map(line).join("\n");
    if (text.length > SNAPSHOT_BUDGET) {
      budgeted = true;
      const vh = await this.viewportHeight();
      const keep: SnapNode[] = [];
      let passed = false;
      for (const n of nodes) {
        if (!n.interactive) continue;
        if (passed) { below++; continue; }
        const y = await this.boxTop(n.backendNodeId);
        if (!y) continue; // not rendered
        if (y.bottom <= 0) { above++; continue; }
        if (y.top >= vh * 2) { passed = true; below++; continue; }
        keep.push(n);
      }
      shown = keep;
      const notes = [`${below} more elements below; scroll or use find`];
      if (above) notes.unshift(`${above} more elements above`);
      text = `Large page: showing interactive elements in view and one screen below.\n${keep.map(line).join("\n")}\n${notes.join("; ")}`;
    }
    text = maskSensitiveValues(text, sensitive);
    const snap: Snapshot = { url: this.opts.url(), frameLoader: main, nodes, dialogs: nodes.filter((n) => n.role === "dialog" || n.role === "alertdialog").map((n) => n.name), text, shown: shown.length, below, above, budgeted };
    this.last = snap;
    return snap;
  }

  /** The snapshot as the bot sees it: already masked, now fenced as page data. */
  fenced(s: Snapshot): string {
    return fencePageText(s.text, { origin: this.opts.origin(), kind: "snapshot" });
  }

  private async viewportHeight(): Promise<number> {
    try { const m = await this.send("Page.getLayoutMetrics"); return Number(m.cssLayoutViewport?.clientHeight ?? m.layoutViewport?.clientHeight) || 800; } catch { return 800; }
  }
  private async boxTop(backendNodeId: number): Promise<{ top: number; bottom: number } | undefined> {
    try {
      const { model } = await this.send("DOM.getBoxModel", { backendNodeId });
      const ys: number[] = (model.border ?? model.content).filter((_: number, i: number) => i % 2 === 1);
      return { top: Math.min(...ys), bottom: Math.max(...ys) };
    } catch { return undefined; }
  }

  /** Resolves a ref to a live backend node. Recovers by role, name and position before giving up. */
  async resolve(ref: string): Promise<{ backendNodeId: number; recovered: boolean }> {
    const key = ref.replace(/^@/, "");
    const entry = this.refs.get(key);
    if (!entry) throw new ReadLayerError("unknown_ref", "That element reference is not known. Take a new snapshot.");
    const { main, map } = await this.frames();
    if (map.get(entry.frameLoader.split(":")[0]!) !== entry.frameLoader) {
      this.refs.delete(key);
      throw new ReadLayerError("expired_ref", "The page has navigated since that snapshot, so the reference expired. Take a new snapshot.");
    }
    try { await this.send("DOM.describeNode", { backendNodeId: entry.backendNodeId }); return { backendNodeId: entry.backendNodeId, recovered: false }; } catch { /* replaced: recover below */ }
    const taken = new Set([...this.refs.values()].filter((n) => n.ref !== key).map((n) => n.backendNodeId));
    const pick = (await this.axNodes(map, main))
      .filter((n) => n.frameLoader === entry.frameLoader && n.role === entry.role && this.safeName(n.role, n.name) === entry.name && !taken.has(n.backendNodeId))
      .sort((a, b) => Math.abs(a.ordinal - entry.ordinal) - Math.abs(b.ordinal - entry.ordinal))[0];
    if (!pick) { this.refs.delete(key); throw new ReadLayerError("gone_ref", "That element is no longer on the page. Take a new snapshot or use find."); }
    this.byKey.delete(entry.key);
    entry.backendNodeId = pick.backendNodeId; entry.key = `${entry.frameLoader}:${pick.backendNodeId}`; entry.ordinal = pick.ordinal;
    this.byKey.set(entry.key, key);
    return { backendNodeId: pick.backendNodeId, recovered: true };
  }

  /** After an L2 or L3 action: what changed since the last snapshot, fenced. Null when nothing did. */
  async diffSince(): Promise<string | null> {
    const prev = this.last;
    if (!prev) return null;
    const before = this.secrets, next = await this.snapshot();
    return formatDiff(prev, next, this.opts.origin(), [...before, ...this.secrets]);
  }

  /** Plain-words reason a click on this node would land on something else. Null when nothing covers it. */
  async explainCover(backendNodeId: number, targetRole = "element"): Promise<string | null> {
    const { object } = await this.send("DOM.resolveNode", { backendNodeId });
    const r = await this.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true, functionDeclaration: COVER_SOURCE });
    const f = r?.result?.value as CoverFacts | null | undefined;
    return f ? coverSentence(f, targetRole) : null;
  }
}

export type CoverFacts = { tag: string; role?: string; id?: string; cls?: string; text?: string; modal?: boolean; fixed?: boolean };
export const COVER_SOURCE = String.raw`function(){const dom=(${NATIVE_DOM_SOURCE})();var r=this.getBoundingClientRect();var e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);if(!e||e===this||dom.contains(this,e)||dom.contains(e,this))return null;var c=e,fixed=false;for(var i=0;c&&dom.kind(c)===1&&i<6;i++,c=dom.parent(c)){var p=getComputedStyle(c).position;if(p==='fixed'||p==='sticky'){fixed=true;break}}var t=c&&dom.kind(c)===1?c:e;const result={tag:dom.tag(e),role:dom.attr(t,'role')||'',id:dom.attr(t,'id')||'',cls:String(dom.attr(t,'class')||'').slice(0,200),text:(dom.text(t)||'').slice(0,200),modal:dom.attr(t,'aria-modal')==='true'||dom.tag(t)==='dialog',fixed:fixed};dom.assertComplete();return result}`;

/** A page-supplied word (tag name, role attribute) inside Murage's own sentence: one plain token or a neutral word. */
const plainWord = (value: unknown, fallback: string) => { const word = String(value ?? "").toLowerCase(); return /^[a-z][a-z0-9-]{0,23}$/.test(word) ? word : fallback; };
export function coverSentence(f: CoverFacts, targetRole = "element"): string {
  targetRole = plainWord(targetRole, "element");
  const hay = `${f.id ?? ""} ${f.cls ?? ""} ${f.text ?? ""}`;
  const who = /cookie|consent|gdpr|privacy/i.test(hay) ? "A cookie banner"
    : f.modal || /dialog|modal/.test(f.role ?? "") || /modal|dialog|popup|overlay/i.test(`${f.id} ${f.cls}`) ? "A dialog"
    : /newsletter|subscribe|sign.?up/i.test(hay) ? "A sign-up popup"
    : f.fixed && /header|nav|toolbar/i.test(`${f.tag} ${f.id} ${f.cls} ${f.role}`) ? "A sticky header"
    : f.fixed ? "A floating panel"
    : `Another ${plainWord(f.tag, "page")} element`;
  return `${who} covers this ${targetRole}. Deal with it first, then try again.`;
}

const list = (xs: SnapNode[]) => xs.slice(0, 8).map((n) => `${label(n)} [ref=${n.ref}]`).join("\n") + (xs.length > 8 ? `\n...and ${xs.length - 8} more` : "");

export function formatDiff(prev: Pick<Snapshot, "url" | "nodes" | "dialogs">, next: Pick<Snapshot, "url" | "nodes" | "dialogs">, origin: string, secrets: string[] = []): string | null {
  const lead: string[] = [];
  if (prev.url !== next.url) lead.push(`The page address changed to ${next.url}.`);
  const before = new Set(prev.nodes.filter((n) => n.interactive).map((n) => n.key));
  const after = new Set(next.nodes.filter((n) => n.interactive).map((n) => n.key));
  const added = next.nodes.filter((n) => n.interactive && !before.has(n.key));
  const removed = prev.nodes.filter((n) => n.interactive && !after.has(n.key));
  const newDialogs = next.dialogs.filter((d) => !prev.dialogs.includes(d));
  const body: string[] = [];
  if (added.length) body.push(`New (${added.length}):\n${list(added)}`);
  if (removed.length) body.push(`Gone (${removed.length}):\n${list(removed)}`);
  if (newDialogs.length) body.push(`Dialog opened:\n${newDialogs.map(q).join("\n")}`);
  if (!lead.length && !body.length) return null;
  // Round 10 (R9-02): every diff line is redacted against the field values the page held, whatever node it came from.
  let bodyText = body.join("\n");
  for (const v of secrets) if (v.length >= 3) bodyText = bodyText.split(v).join("[hidden]");
  bodyText = bodyText.replace(/"([^"\n]*)"/g, (m, inner) => (looksLikeSecretValue(inner) ? '"[hidden]"' : m));
  const fenced = body.length ? "\n" + fencePageText(bodyText, { origin, kind: "diff" }) : "";
  return `What changed:${lead.length ? "\n" + lead.join("\n") : ""}${fenced}`;
}

/** A `read` over 20,000 characters returns the first part plus a filtered-read hint. Never an error. */
export function capReadText(text: string, limit = READ_BUDGET): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit), nl = cut.lastIndexOf("\n");
  const head = nl > limit * 0.8 ? cut.slice(0, nl) : cut;
  return { text: `${head}\n\n[Showing the first ${head.length} of ${text.length} characters. Use read with filter set to specific text to find matching lines or sections on the page.]`, truncated: true };
}
