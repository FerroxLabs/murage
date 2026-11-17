// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Allows belong to one turn and session. An execution binds one allow for the
 * rest of that turn, including its terminal reports. Rejects are never stored. */
export class ToolTripwire {
  private allows: Array<{ id: string | undefined; identity: string | undefined; input: string | undefined; session: string; binding?: string }> = [];

  record(id: unknown, identity: string | undefined, input: unknown, session: string): () => void {
    const allow = { id: validId(id) ? id : undefined, identity, input: JSON.stringify(input), session };
    this.allows.push(allow);
    return () => { const at = this.allows.indexOf(allow); if (at >= 0) this.allows.splice(at, 1); };
  }

  accepts(id: unknown, identity: string | undefined, input: unknown, session: string): boolean {
    if (!validId(id)) return false;
    const bound = this.allows.find(a => a.session === session && a.binding === id);
    if (bound) return true;
    const exact = this.allows.find(a => a.session === session && a.id === id && a.binding === undefined);
    if (exact) { exact.binding = id; return true; }
    if (!identity?.trim()) return false;
    const serialized = JSON.stringify(input);
    const candidates = this.allows.filter(a => a.session === session && a.binding === undefined && a.identity?.trim() && a.identity === identity && a.input === serialized);
    if (candidates.length !== 1) return false;
    candidates[0]!.binding = id;
    return true;
  }
}

function validId(id: unknown): id is string { return typeof id === 'string' && id.trim().length > 0; }

// r1.2 production Hermes correlation. The compatibility adapter above serves
// other ACP integrations; Hermes consumes complete, unmerged protocol frames.
import { canonicalJson, classifyAsk, startIdentity, HERMES_TITLE, C1_DEFAULT, HERMES_C2, driverAskRecord, matchesDriverAsk, toolIdentity, HERMES_VERSION_PIN, type DriverAskRecord, type EngineFrame, type HermesAsk } from "../../../shared/tool-identity.ts";

const POLISHED = new Set(`todo memory session_search delegate_task read_file write_file patch search_files terminal process
execute_code skill_view skills_list skill_manage web_search web_extract browser_navigate browser_click browser_type
browser_press browser_scroll browser_back browser_snapshot browser_console browser_get_images browser_vision
vision_analyze image_generate text_to_speech cronjob send_message clarify discord discord_admin feishu_doc_read
feishu_drive_list_comments feishu_drive_list_comment_replies feishu_drive_reply_comment feishu_drive_add_comment
kanban_create kanban_show kanban_comment kanban_complete kanban_block kanban_request_review kanban_request_changes
kanban_link kanban_heartbeat yb_query_group_info yb_query_group_members yb_search_sticker yb_send_dm yb_send_sticker`.split(/\s+/));
type Frame = EngineFrame & { content?: Array<{ type?: string; content?: { type?: string; text?: string } }>; locations?: Array<{ path?: unknown }>; status?: string };
type Token = { key: string; name: string; input: Record<string, unknown>; consumed: boolean; expired: boolean; parent: unknown; ask: unknown };
type Obligation = { key: string; path: unknown; satisfied: boolean; open: boolean; tcid: unknown; ask?: unknown };
type Execution = { tcid: unknown; name: string; key: string; kind: unknown; status: string | null; echo: unknown; auth: string | null; obligation: Obligation | null };
type Ask = { classification: HermesAsk; tcid: unknown; record: DriverAskRecord; sent: string | null; closed: boolean; obligation?: Obligation; bind?: ["exec", Execution] | ["nested", Token] };
export interface HermesTraceContext { c1?: string[]; c3?: string[]; host_computer?: boolean; computer_servers?: number; admin_pre_tool_call?: unknown[]; d5_policy?: "drop" | "refuse" }
export interface HermesTrace { ctx?: HermesTraceContext; frames: Array<{ dir: string; msg: any }> }
const startText = (u: Frame) => u.content?.[0]?.type === "content" && u.content[0].content?.type === "text" ? u.content[0].content.text ?? null : null;
export function executeCodeEcho(code: string): string {
  const points = Array.from(code);
  const preview = points.slice(0, 1200).join("") + (points.length > 1200 ? `\n... (${points.length} chars total, truncated)` : "");
  return preview ? `Running Python helper script:\n\n\`\`\`python\n${preview}\n\`\`\`` : "Running Python helper script";
}
function echoOK(name: string, input: Record<string, unknown>, u: Frame): boolean {
  if (name === "terminal") return typeof input.command === "string" && startText(u) === "$ " + input.command;
  if (name === "execute_code") return typeof input.code === "string" && startText(u) === executeCodeEcho(input.code);
  if (!POLISHED.has(name)) return Object.hasOwn(u, "rawInput") ? canonicalJson(u.rawInput) === canonicalJson(input) : Object.keys(input).length === 0;
  return true;
}
export class HermesTrip extends Error {
  readonly at: number;
  constructor(at: number, why: string) { super(why); this.at = at; }
}
/** Driver-local state: no server start-frame cache and no wire binding field. */
export class HermesCorrelation {
  version: unknown = null;
  mode: unknown = null;
  readonly asks = new Map<unknown, Ask>();
  private readonly askByTc = new Map<unknown, Ask>();
  private readonly tokens: Token[] = [];
  private readonly execs = new Map<unknown, Execution>();
  private readonly obligations: Obligation[] = [];
  readonly sent: Record<string, string> = {};
  readonly errors: string[] = [];
  readonly performed: Array<[string, string | null, string]> = [];
  overlay: string[] | null = null;
  private readonly pendingReload = new Map<unknown, unknown>();
  readonly ctx: HermesTraceContext;
  constructor(ctx: HermesTraceContext = {}) { this.ctx = ctx; }
  private openExecuteCode(): unknown {
    return [...this.execs.values()].filter(e => e.name === "execute_code" && e.status === null).at(-1)?.tcid ?? null;
  }
  onAsk(i: number, msg: any): void {
    const tc: Frame = msg.params.toolCall;
    let classification = classifyAsk(tc, this.version);
    const a: Ask = { classification, tcid: tc.toolCallId, record: driverAskRecord(tc, toolIdentity("hermes", tc, { hermesVersion: typeof this.version === "string" ? this.version : undefined, hermesInstallSha: HERMES_VERSION_PIN["0.22.2"] }), null), sent: null, closed: false };
    if (this.askByTc.has(a.tcid) || this.execs.has(a.tcid)) throw new HermesTrip(i, "ask toolCallId reused");
    if (classification.type === "edit") {
      const c = classification;
      const candidates = this.obligations.filter(o => o.key === c.key && !o.satisfied && o.open && (c.arguments.mode !== "patch" ? o.path === (c.arguments.path ?? null) : o.path === null));
      if (candidates.length) a.obligation = candidates[0];
      else classification = { type: "unproven" };
    } else if (classification.type === "cmd") {
      const c = classification;
      const execs = [...this.execs.values()].filter(e => e.name === "terminal" && e.status === null && e.echo === "$ " + c.command);
      const nested = this.tokens.filter(t => !t.consumed && !t.expired && t.parent && t.key === "hermes/hermes/terminal" && t.input.command === c.command);
      if (execs.length === 1) a.bind = ["exec", execs[0]!];
      else if (!execs.length && nested.length === 1) a.bind = ["nested", nested[0]!];
      else classification = { type: "unproven" };
    }
    a.classification = classification;
    a.record = driverAskRecord(tc, a.record.identity, a.bind ?? a.obligation ?? null);
    this.asks.set(msg.id, a);
    this.askByTc.set(a.tcid, a);
  }
  onAnswer(_i: number, msg: any): void {
    const a = this.asks.get(msg.id);
    if (!a || a.sent !== null) return;
    let allow = ["allow_once", "allow_session", "allow_always"].includes(msg.result?.outcome?.optionId);
    const reload = this.pendingReload.get(a.tcid);
    if (allow && (a.classification.type === "unproven" || (reload !== undefined && !matchesDriverAsk(a.record, reload)))) {
      this.errors.push(`runtime.error: allow on ${reload === undefined ? a.classification.type : "reloaded"} ask ${a.tcid} sent as reject`);
      allow = false;
    }
    a.sent = allow ? "allow" : "reject";
    Object.defineProperty(this.sent, String(a.tcid), { value: a.sent, enumerable: true, configurable: true });
    if (!allow) return;
    const c = a.classification;
    if (c.type === "hook") this.tokens.push({ key: c.key, name: c.name, input: c.input, consumed: false, expired: false, parent: this.openExecuteCode(), ask: a.tcid });
    else if (c.type === "edit") { a.obligation!.satisfied = true; a.obligation!.ask = a.tcid; }
    else if (c.type === "cmd" && a.bind?.[0] === "nested") {
      const target = a.bind[1]; target.consumed = true;
      this.performed.push([target.key, "nested:" + target.parent, "in-parent"]);
    }
  }
  onStart(i: number, u: Frame): void {
    const tcid = u.toolCallId;
    if (this.execs.has(tcid) || this.askByTc.has(tcid)) throw new HermesTrip(i, "start reuses an id");
    const name = startIdentity(u, this.version);
    if (name === null) throw new HermesTrip(i, "start identity unproven");
    const key = "hermes/hermes/" + name;
    const e: Execution = { tcid, name, key, kind: u.kind, status: null, echo: startText(u), auth: null, obligation: null };
    if (((this.ctx.c1 ?? C1_DEFAULT) as readonly string[]).includes(name)) e.auth = "C1";
    else if ((HERMES_C2 as readonly string[]).includes(name)) {
      if (u.content?.some(x => x.type === "diff")) throw new HermesTrip(i, "edit start carries a diff: Hermes approved it itself");
      const ob: Obligation = { key, path: u.locations?.[0]?.path ?? null, satisfied: false, open: true, tcid };
      this.obligations.push(ob); e.obligation = ob; e.auth = "C2";
    } else if (this.ctx.c3?.includes(name)) e.auth = "C3";
    else if (this.ctx.host_computer && /^mcp__computer__[A-Za-z0-9_]+$/.test(name) && (this.ctx.computer_servers ?? 1) === 1) e.auth = "C4";
    else {
      for (const t of this.tokens) {
        if (!t.consumed && !t.expired && t.key === key && echoOK(name, t.input, u)) { t.consumed = true; e.auth = "token:" + t.ask; break; }
      }
      if (e.auth === null) throw new HermesTrip(i, "no token for " + key);
    }
    this.execs.set(tcid, e);
  }
  isPermissionCompletion(tcid: unknown): boolean { return this.askByTc.has(tcid); }
  onUpdate(i: number, u: Frame): void {
    const tcid = u.toolCallId;
    const a = this.askByTc.get(tcid);
    if (a) {
      if (a.sent === null || a.closed || Object.keys(u).some(k => !["sessionUpdate", "toolCallId", "status"].includes(k)) || !["completed", "failed"].includes(u.status ?? "")) throw new HermesTrip(i, "bad permission completion");
      a.closed = true; return;
    }
    const e = this.execs.get(tcid);
    if (!e) throw new HermesTrip(i, "update for an unknown execution");
    if (e.status !== null) throw new HermesTrip(i, "update after the execution ended");
    if (Object.hasOwn(u, "kind") && u.kind !== e.kind) throw new HermesTrip(i, "frozen kind changed");
    if (Object.hasOwn(u, "title")) {
      const m = typeof u.title === "string" ? HERMES_TITLE.exec(u.title) : null;
      if (!m || m[1] !== e.name) throw new HermesTrip(i, "frozen title changed");
    }
    if (u.status === "completed" || u.status === "failed") {
      if (e.obligation) {
        e.obligation.open = false;
        if (u.status === "completed" && !e.obligation.satisfied) throw new HermesTrip(i, "edit completed without a bound edit allow");
      }
      e.status = u.status;
      this.performed.push([e.key, e.auth, u.status]);
      if (e.name === "execute_code") for (const t of this.tokens) if (t.parent === tcid && !t.consumed) t.expired = true;
    }
  }
  onPrompt(): "refuse" | null {
    if (this.ctx.admin_pre_tool_call?.length && this.ctx.d5_policy === "refuse") return "refuse";
    this.overlay = ["murage"];
    return this.mode !== "default" ? "refuse" : null;
  }
  reload(tcid: unknown, frame: unknown): void { this.pendingReload.set(tcid, frame); }
  unperformed(): unknown[] {
    const left: unknown[] = [];
    for (const a of this.asks.values()) {
      if (a.sent !== "allow") continue;
      if (a.classification.type === "hook") {
        const tok = this.tokens.find(t => t.ask === a.tcid);
        const used = tok?.consumed && (this.performed.some(p => p[1] === "token:" + a.tcid) || (tok.parent && this.performed.some(p => p[1] === "nested:" + tok.parent)));
        if (!used) left.push(a.tcid);
      } else if (a.classification.type === "edit") {
        if (this.execs.get(a.obligation?.tcid)?.status == null) left.push(a.tcid);
      } else if (a.classification.type === "cmd" && a.bind?.[0] === "exec" && a.bind[1].status === null) left.push(a.tcid);
    }
    return left;
  }
}
export function runHermesTrace(trace: HermesTrace) {
  const f = new HermesCorrelation(trace.ctx);
  const out = { result: "accept", trip_at: null as number | null, why: "", sent: f.sent, overlay: null as string[] | null, performed: f.performed, errors: f.errors, unperformed: [] as unknown[] };
  try {
    for (const [i, fr] of trace.frames.entries()) {
      const m = fr.msg;
      if (fr.dir === "ctl") { if (m.reload) f.reload(m.reload.toolCallId, m.reload.identityFrame); continue; }
      if (fr.dir === "in") {
        if (m.method === "session/prompt") {
          const result = f.onPrompt(); out.overlay = f.overlay;
          if (result) return { ...out, result, trip_at: i, why: "turn refused before prompt" };
        } else if (m.method === "session/set_mode") f.mode = m.params.modeId;
        else if ("result" in m && "id" in m) f.onAnswer(i, m);
        continue;
      }
      if (m.result && typeof m.result === "object") {
        if (m.result.agentInfo) f.version = m.result.agentInfo.version;
        if (m.result.modes) f.mode = m.result.modes.currentModeId;
        continue;
      }
      if (m.method === "session/request_permission") f.onAsk(i, m);
      else if (m.method === "session/update") {
        const u = m.params.update;
        if (u.sessionUpdate === "tool_call") f.onStart(i, u);
        else if (u.sessionUpdate === "tool_call_update") f.onUpdate(i, u);
      }
    }
  } catch (error) {
    if (!(error instanceof HermesTrip)) throw error;
    out.result = "trip"; out.trip_at = error.at; out.why = error.message;
  }
  out.overlay = f.overlay; out.unperformed = f.unperformed();
  return out;
}
