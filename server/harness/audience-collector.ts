import { QUESTION_LIMITS, type QuestionSpec, type QuestionAnswer } from '../../shared/questions.ts';
// PROVISIONAL INTERFACE: the design freezes resolveDisplayAction(card, action)
// but not the card argument. It is an authoritative stored-message view, never
// the client display copy; live is checked by the caller for permissions only.
export type DisplayActionCard = Readonly<{
  id: string; requestType: 'question' | 'permission'; questions?: readonly QuestionSpec[];
  live?: boolean;
}>;
export type DisplayActionResolution =
  | { ok: true; legacyBody: { behavior: 'answer' | 'deny' | 'allow'; answers?: QuestionAnswer[]; sentAsMessage?: true } }
  | { ok: false; status: 400 | 409; error: string };
const invalidAction = (): DisplayActionResolution => ({ ok: false, status: 400, error: 'invalid_display_action' });
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

/** Resolve the whole submission before handing any authority back to the route.
 * This function has no store, adapter, logging or send side effects. */
export function resolveDisplayAction(card: DisplayActionCard, action: unknown): DisplayActionResolution {
  if (!record(action) || action.requestHandle !== `${card.requestType === 'question' ? 'q' : 'p'}.${card.id}`) return invalidAction();
  if (card.requestType === 'permission') {
    if (!only(action, ['requestHandle', 'action']) || (action.action !== 'allow' && action.action !== 'deny')) return invalidAction();
    if (!card.live) return { ok: false, status: 409, error: 'request_unavailable' };
    return { ok: true, legacyBody: { behavior: action.action } };
  }
  if (action.action === 'skip') {
    return only(action, ['requestHandle', 'action']) ? { ok: true, legacyBody: { behavior: 'deny' } } : invalidAction();
  }
  if (action.action !== 'answer' || !only(action, ['requestHandle', 'action', 'answers', 'sentAsMessage']) ||
      ('sentAsMessage' in action && action.sentAsMessage !== true) || !Array.isArray(action.answers)) return invalidAction();
  const questions = card.questions ?? [];
  if (!questions.length || questions.length > QUESTION_LIMITS.questions || action.answers.length !== questions.length) return invalidAction();
  const resolved = new Map<number, QuestionAnswer>();
  for (const answer of action.answers) {
    if (!record(answer) || !only(answer, ['questionHandle', 'optionHandles', 'other']) || typeof answer.questionHandle !== 'string' || !/^q\.(0|[1-9]\d*)$/.test(answer.questionHandle)) return invalidAction();
    const index = Number(answer.questionHandle.slice(2));
    const question = questions[index];
    if (!question || resolved.has(index) || !Array.isArray(answer.optionHandles) || answer.optionHandles.length > QUESTION_LIMITS.options) return invalidAction();
    if ('other' in answer && (!question.allowOther || typeof answer.other !== 'string' || answer.other.length > QUESTION_LIMITS.otherChars)) return invalidAction();
    const selected = new Set<number>();
    for (const handle of answer.optionHandles) {
      if (typeof handle !== 'string') return invalidAction();
      const match = /^o\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(handle);
      if (!match || Number(match[1]) !== index) return invalidAction();
      const option = Number(match[2]);
      if (!question.options[option] || selected.has(option)) return invalidAction();
      selected.add(option);
    }
    const count = selected.size + (typeof answer.other === 'string' && answer.other.trim() ? 1 : 0);
    if (count === 0 || (!question.multiSelect && count > 1)) return invalidAction();
    resolved.set(index, { id: question.id, selected: question.options.filter((_, i) => selected.has(i)).map(option => option.label),
      ...(typeof answer.other === 'string' ? { other: answer.other } : {}) });
  }
  return { ok: true, legacyBody: { behavior: 'answer', answers: questions.map((_, i) => resolved.get(i)!), ...(action.sentAsMessage === true ? { sentAsMessage: true } : {}) } };
}

/** Preserve the established approval transport alongside the strict F8 action.
 * These fields grant nothing here; the response route still runs the original
 * scope, render-receipt and fresh-auth checks against the stored card. */
export function resolveDisplaySubmission(card: DisplayActionCard, submission: unknown):
  | { ok: true; legacyBody: Extract<DisplayActionResolution, { ok: true }>['legacyBody'] & Record<string, unknown> }
  | Extract<DisplayActionResolution, { ok: false }> {
  if (!record(submission)) return invalidAction();
  const action = { ...submission }, transport: Record<string, unknown> = {};
  for (const key of ['allowForTask', 'freshAuth', 'seen', 'reviewedSha256', 'reviewDigest']) {
    if (!Object.hasOwn(action, key)) continue;
    const value = action[key];
    if (key === 'allowForTask' && (value !== true || card.requestType !== 'permission' || action.action !== 'allow')) return invalidAction();
    if ((key === 'freshAuth' || key === 'seen') && !record(value)) return invalidAction();
    if ((key === 'reviewedSha256' || key === 'reviewDigest') && typeof value !== 'string') return invalidAction();
    transport[key] = value; delete action[key];
  }
  const resolved = resolveDisplayAction(card, action);
  return resolved.ok ? { ok: true, legacyBody: { ...resolved.legacyBody, ...transport } } : resolved;
}

import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type {
  AttachmentCapability, AudienceCollector, AudienceEmission, AudienceEvent, ExecutionEvent,
  HostEnvelope, IntakeResult, ManifestBatch, ManifestVariant, PolicyDecision,
  SourceContext, TextCarrier, TrustedSendContext, TurnAdmission, TurnTextPolicy,
} from '../contracts.ts';
import { boundedEventCharge, type EventCharge } from './event-charge.ts';

const charges = new WeakMap<object, EventCharge>();
export const attachedEventCharge = (event: object): EventCharge | undefined => charges.get(event);
// PROVISIONAL INTERFACE: the bus's provider-instance wrapper inherits the
// original graph's accounting. It must not traverse the payload a second time.
export function chargeExecutionEvent(event: object, original: object = event): EventCharge {
  let charge = charges.get(original);
  if (!charge) { charge = boundedEventCharge(original); charges.set(original, charge); }
  charges.set(event, charge);
  return charge;
}
const MARKER = '«redacted»' as const;
const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d) return undefined;
  if (!('value' in d)) throw new Error('accessor');
  return d.value;
};

/** Default while the separately owned policy is not installed: no text is
 * admitted. PROVISIONAL INTERFACE: F2 freezes the policy object but not its
 * factory or installation; the constructor accepts the frozen interface. */
const failClosedPolicy: TurnTextPolicy = {
  admit() {}, retire() {},
  consume(_cap, batch) { return { masked: true, exhausted: false, operations: batch.carriers.map(c => ({ path: c.path, stream: c.stream, regionId: c.stream, revision: 1, op: 'replace', text: MARKER, speech: 'none' })) }; },
  reset() { return { masked: true, exhausted: false, operations: [] }; },
  finish() { return { masked: true, exhausted: false, operations: [] }; },
};

// PROVISIONAL INTERFACE: 1A owns the implementation module; the narrow
// factory name is createTurnTextPolicy. The isolated 1B checkout has no 1A
// files, so absence fails closed. The integrated head must supply the policy.
let createPolicy: ((options?: { separateItemRegions?: boolean }) => TurnTextPolicy) | undefined;
try {
  const module = await import('../redact-turn.ts') as unknown as { createTurnTextPolicy?: (options?: { separateItemRegions?: boolean }) => TurnTextPolicy };
  createPolicy = module.createTurnTextPolicy;
} catch { /* no input text is included in the missing-policy diagnostic */ }

const TURN_ITEM_LIMIT = 1024;
const DISPLAY_STREAM_LIMIT = 256;
const SNAPSHOT_SCALAR_LIMIT = 262_144;
const TURN_SNAPSHOT_SCALAR_LIMIT = 64 * SNAPSHOT_SCALAR_LIMIT;

type AdmissionRecord = { host: TrustedSendContext; generation: number; active: boolean; masked: boolean; items: Map<string, string>; regions: Set<string>; snapshotScalars: number; snapshots: Map<string, { text: string; regionId: string; revision: number; speech: 'append' | 'none' }>; streamed: Set<string>; anonymousAssistant: number };
type AttachmentRecord = { instanceId: string; active: boolean; admissions: Set<TurnAdmission> };
const variants: Record<ExecutionEvent['type'], ManifestVariant | ((event: ExecutionEvent) => ManifestVariant)> = {
  'turn.diagnostic': 'M01', 'session.started': 'M02', 'turn.subtask': 'M03', 'session.exited': 'M04', 'turn.started': 'M05', 'turn.retrying': 'M06', 'turn.completed': 'M07',
  'item.started': e => own(e, 'itemType') === 'tool' ? 'M08' : own(e, 'itemType') === 'reasoning' ? 'M09' : 'M29',
  'item.updated': e => own(e, 'itemType') === 'tool' ? 'M10' : own(e, 'itemType') === 'reasoning' ? 'M11' : 'M29',
  'item.completed': e => own(e, 'itemType') === 'tool' ? 'M12' : own(e, 'itemType') === 'assistant_text' ? 'M13' : own(e, 'itemType') === 'assistant_image' ? 'M14' : 'M29',
  'content.delta': e => own(e, 'streamKind') === 'assistant_text' ? 'M15' : own(e, 'streamKind') === 'reasoning_text' ? 'M16' : 'M29',
  'content.reset': e => own(e, 'streamKind') === 'assistant_text' ? 'M17' : own(e, 'streamKind') === 'reasoning_text' ? 'M18' : 'M29',
  'plan.updated': 'M19', 'engine.commands': 'M20', 'steer.confirmed': 'M21', 'question.async': 'M22',
  'request.opened': e => own(e, 'requestType') === 'permission' ? 'M23' : own(e, 'requestType') === 'question' ? 'M24' : 'M29',
  'request.resolved': 'M25', 'thread.token-usage.updated': 'M26', 'turn.served-model': 'M27', 'runtime.error': 'M28',
};

const SESSION_TOKEN = '{session}';
const RESULT_DIR_KINDS: Readonly<Record<string, string>> = { projects: 'tool-results', sessions: 'mcp' };
/** Fixed host form `<prefix>/projects/<key>/<session>/tool-results` or `<prefix>/sessions/<key>/<session>/mcp`
 * (either separator, shape of `own-tool-results.ts`): the session segment becomes a host token.
 * Any other entry is returned whole and scanned as is. */
function toolResultDirDisplay(entry: string): string {
  const parts = entry.split(/[\\/]/); const n = parts.length;
  if (n < 5) return entry;
  const [kind, key, session, leaf] = parts.slice(n - 4) as [string, string, string, string];
  if (!Object.hasOwn(RESULT_DIR_KINDS, kind) || RESULT_DIR_KINDS[kind] !== leaf) return entry;
  if (!key || !parts.slice(0, n - 4).join('/') || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(session)) return entry;
  const at = entry.length - leaf.length - 1 - session.length;
  return entry.slice(0, at) + SESSION_TOKEN + entry.slice(at + session.length);
}

/** Explicit manifest extractor. Fixed schema reads never evaluate an accessor
 * or walk an unknown subtree. Tool previews are the only arbitrary maps, and
 * output their keys as scanned values in fixed {key,value} slots. */
function extract(event: ExecutionEvent, envelope: HostEnvelope, stream: string): { batch: ManifestBatch; shape: Record<string, unknown> } {
  let nodes = 0, units = 0;
  const carriers: TextCarrier[] = [];
  const charge = (n: number) => { units += n; if (units > 262_144 || ++nodes > 20_000) throw new Error('budget'); };
  const value = (object: unknown, key: string) => { charge(key.length + 4); return own(object, key); };
  const type = value(event, 'type');
  const variantFn = typeof type === 'string' ? variants[type as ExecutionEvent['type']] : undefined;
  const variant = typeof variantFn === 'function' ? variantFn(event) : variantFn ?? 'M29';
  if (variant === 'M29') throw new Error('unknown_variant');
  const shape: Record<string, unknown> = { type };
  const text = (object: unknown, key: string, target: Record<string, unknown>, path = key, mode: TextCarrier['mode'] = 'whole', display?: (raw: string) => string) => {
    const raw = value(object, key); if (raw === undefined) return;
    if (typeof raw !== 'string') throw new Error('text_shape');
    charge(raw.length);
    carriers.push({ path, stream: mode === 'whole' ? `${stream}:${path}` : stream, mode, text: display ? display(raw) : raw });
    target[key] = ''; // filled only from a policy decision after the entire batch
  };
  const num = (object: unknown, key: string, target: Record<string, unknown>) => { const n = value(object, key); if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER) target[key] = n; };
  const bool = (object: unknown, key: string, target: Record<string, unknown>) => { const b = value(object, key); if (typeof b === 'boolean') target[key] = b; };
  const enumeration = (object: unknown, key: string, target: Record<string, unknown>, allowed: readonly string[]) => { const s = value(object, key); if (typeof s === 'string' && allowed.includes(s)) target[key] = s; };
  const array = (object: unknown, key: string, max: number, visit: (entry: unknown, i: number) => unknown): unknown[] | undefined => {
    const raw = value(object, key); if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || types.isProxy(raw)) throw new Error('array_shape');
    const length = own(raw, 'length') as number; charge(length);
    if (length > max) throw new Error('array_budget');
    return Array.from({ length }, (_, i) => visit(value(raw, String(i)), i));
  };
  const strings = (key: string, max = 256, display?: (raw: string) => string) => {
    const entries = array(event, key, max, (entry, i) => { const target = { value: entry }; text(target, 'value', target, `${key}.${i}`, 'whole', display); return target.value; });
    if (entries) shape[key] = entries;
  };
  const questions = () => {
    const rows = array(event, 'questions', QUESTION_LIMITS.questions, (q, i) => {
      const out: Record<string, unknown> = { handle: `q.${i}`, options: [] };
      for (const key of ['question', 'header']) text(q, key, out, `questions.${i}.${key}`);
      for (const key of ['multiSelect', 'allowOther', 'secret']) bool(q, key, out);
      out.options = array(q, 'options', QUESTION_LIMITS.options, (o, j) => {
        const option: Record<string, unknown> = { handle: `o.${i}.${j}` };
        for (const key of ['label', 'description']) text(o, key, option, `questions.${i}.options.${j}.${key}`);
        return option;
      }) ?? [];
      return out;
    });
    if (rows) shape.questions = rows;
  };
  const preview = (key: string) => {
    const input = value(event, key); if (input === undefined) return;
    const rows: { key: string; value: string }[] = [];
    const visit = (raw: unknown, label: string, depth: number) => {
      charge(label.length); if (depth > 40) throw new Error('depth');
      if (typeof raw === 'string' || raw === null || typeof raw === 'boolean' || typeof raw === 'number') {
        if (typeof raw === 'string') charge(raw.length);
        const i = rows.length, row = { key: label, value: typeof raw === 'string' ? raw : String(raw) };
        text(row, 'key', row, `preview.${i}.key`); text(row, 'value', row, `preview.${i}.value`); rows.push(row); return;
      }
      if (!raw || typeof raw !== 'object' || types.isProxy(raw)) throw new Error('preview_shape');
      if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== Array.prototype && Object.getPrototypeOf(raw) !== null) throw new Error('prototype');
      for (const k in raw) {
        if (k.length > 1024) throw new Error('key_budget');
        charge(k.length + 4);
        const d = Object.getOwnPropertyDescriptor(raw, k);
        if (!d?.enumerable) continue;
        if (!('value' in d)) throw new Error('accessor');
        visit(d.value, label ? `${label}.${k}` : k, depth + 1);
      }
    };
    visit(input, '', 0); shape.preview = rows;
  };
  switch (type) {
    case 'turn.diagnostic': num(event, 'quietMs', shape); break;
    case 'session.started': text(event, 'model', shape); bool(event, 'replayPending', shape); num(event, 'sessionContract', shape); break;
    case 'turn.subtask': {
      const one = value(event, 'subtask');
      const source = one === undefined ? event : { subtasks: [one] };
      shape.subtasks = array(source, 'subtasks', 64, (sub, i) => {
        const out: Record<string, unknown> = { id: `${envelope.eventId}-${i}` };
        text(sub, 'label', out, `subtasks.${i}.label`); enumeration(sub, 'status', out, ['started', 'running', 'done', 'failed']);
        for (const key of ['startedAt', 'endedAt', 'toolCount']) num(sub, key, out); return out;
      }) ?? []; break;
    }
    case 'session.exited': text(event, 'reason', shape); break;
    case 'turn.started': break;
    case 'turn.retrying': text(event, 'reason', shape); for (const key of ['attempt', 'delayMs', 'maxAttempts']) num(event, key, shape); break;
    case 'turn.completed': {
      text(event, 'stopReason', shape); strings('denials'); strings('toolsUnavailable'); bool(event, 'ok', shape); bool(event, 'chargePartial', shape);
      for (const key of ['cost', 'charge']) num(event, key, shape);
      const raw = value(event, 'usage'); if (raw) { const usage = {}; for (const key of ['input', 'output', 'cachedInput']) num(raw, key, usage); shape.usage = usage; } break;
    }
    case 'item.started': {
      enumeration(event, 'origin', shape, ['engine', 'murage']);
      shape.itemType = value(event, 'itemType');
      for (const key of ['title', 'summary', 'spoken', 'toolKind']) text(event, key, shape);
      const identity = value(event, 'toolIdentity'); if (identity) { const out = {}; for (const key of ['namespace', 'name', 'kind']) text(identity, key, out, `toolIdentity.${key}`); shape.toolIdentity = out; }
      preview('input'); break;
    }
    case 'item.updated': shape.itemType = value(event, 'itemType'); num(event, 'tokens', shape); break;
    case 'item.completed': {
      const itemType = value(event, 'itemType'); shape.itemType = itemType;
      if (itemType === 'assistant_text') text(event, 'text', shape, 'text', 'snapshot');
      if (itemType === 'assistant_image') text(event, 'alt', shape);
      if (itemType === 'tool') { text(event, 'detail', shape); bool(event, 'ok', shape); preview('result'); } break;
    }
    case 'content.delta': shape.streamKind = value(event, 'streamKind'); text(event, 'delta', shape, 'delta', 'delta'); break;
    case 'content.reset': shape.streamKind = value(event, 'streamKind'); break;
    case 'plan.updated': shape.entries = array(event, 'entries', 256, (entry, i) => { const out = {}; text(entry, 'content', out, `entries.${i}.content`); enumeration(entry, 'status', out, ['pending', 'in_progress', 'completed']); return out; }) ?? []; break;
    // Command handles depend on the authoritative bot cache. Intake never invents
    // a command handle from a provider name; the cache API constructs the menu
    // and scans the whole report itself (displayEngineCommands). The report is
    // shape-checked here but carries no text into the turn policy: it displays
    // nothing in this turn, and a fresh session reports every command inside
    // the owner's first turn, whose per-field streams exhausted the turn budget.
    case 'engine.commands': {
      array(event, 'commands', 300, command => { for (const key of ['name', 'description', 'hint']) { const raw = value(command, key); if (raw !== undefined && typeof raw !== 'string') throw new Error('text_shape'); } });
      shape.commands = []; break;
    }
    case 'steer.confirmed': break;
    case 'question.async': questions(); break;
    case 'request.opened': {
      shape.requestType = value(event, 'requestType');
      for (const key of ['tool', 'summary', 'reason', 'toolInput', 'toolInputMissing', 'localHold']) text(event, key, shape);
      // M23/M24: toolResultDirs display copies are T. The raw provider session id stays X (M02), so the copy carries a host token; execution keeps the original paths.
      strings('choices', 10); strings('filePaths'); strings('toolResultDirs', 256, toolResultDirDisplay); questions();
      // Even omitted display extensions participate in the same latch.
      const folder = value(event, 'folderTrust'); if (folder) { text(folder, 'folder', {}, 'folderTrust.folder'); array(folder, 'sources', 256, (v, i) => text({ value: v }, 'value', {}, `folderTrust.sources.${i}`)); }
      const env = value(event, 'envInfo'); if (env) for (const key of ['names', 'absent', 'shell', 'managedEnv']) array(env, key, 256, (v, i) => text({ value: v }, 'value', {}, `envInfo.${key}.${i}`));
      break;
    }
    case 'request.resolved': text(event, 'decidedBy', shape); enumeration(event, 'behavior', shape, ['allow', 'deny', 'answer']); enumeration(event, 'source', shape, ['user', 'auto', 'timeout', 'system', 'unavailable', 'peer']); break;
    case 'thread.token-usage.updated': for (const key of ['input', 'output', 'cachedInput']) num(event, key, shape); break;
    case 'turn.served-model': text(event, 'routed', shape); text(event, 'requested', shape); break;
    case 'runtime.error':
      for (const key of ['message', 'details', 'errorKind', 'engineCode', 'gatewayCode', 'localFailureEngine']) text(event, key, shape);
      for (const nested of ['providerError', 'engine', 'connection']) { const v = value(event, nested); if (v) for (const key of ['providerSaid', 'providerTeam', 'preset']) text(v, key, {}, `${nested}.${key}`); } break;
  }
  return { batch: { envelope, variant, carriers, controls: {}, ...(type === 'turn.completed' ? { terminal: 'complete' as const } : type === 'session.exited' ? { terminal: 'exit' as const } : {}) }, shape };
}

function fill(shape: Record<string, unknown>, path: string, text: string) {
  const parts = path.split('.'); let target: unknown = shape;
  for (const part of parts.slice(0, -1)) {
    if (!target || typeof target !== 'object') return;
    target = (target as Record<string, unknown>)[part];
  }
  if (target && typeof target === 'object' && Object.hasOwn(target, parts.at(-1)!)) (target as Record<string, unknown>)[parts.at(-1)!] = text;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export class RuntimeAudienceCollector implements AudienceCollector {
  private readonly incarnation = randomUUID();
  private readonly attachments = new WeakMap<AttachmentCapability, AttachmentRecord>();
  private readonly admissions = new WeakMap<TurnAdmission, AdmissionRecord>();
  private liveAdmissions = 0;
  private generation = 0;
  private ordinal = 0;
  private readonly policy: TurnTextPolicy;
  constructor(policy: TurnTextPolicy = createPolicy?.({ separateItemRegions: true }) ?? failClosedPolicy) { this.policy = policy; }
  attach(instanceId: string): AttachmentCapability {
    const attachment = Object.freeze({}) as AttachmentCapability;
    this.attachments.set(attachment, { instanceId, active: true, admissions: new Set() }); return attachment;
  }
  admitNewTurn(host: TrustedSendContext): TurnAdmission {
    const attachment = this.attachments.get(host.attachment);
    if (!attachment?.active || attachment.instanceId !== host.instanceId) throw new Error('invalid_attachment');
    const cap = Object.freeze({}) as TurnAdmission;
    const active = this.liveAdmissions < 256;
    this.admissions.set(cap, { host: Object.freeze({ ...host }), generation: ++this.generation, active, masked: false, items: new Map(), regions: new Set(), snapshotScalars: 0, snapshots: new Map(), streamed: new Set(), anonymousAssistant: 0 });
    if (active) { this.liveAdmissions++; attachment.admissions.add(cap); this.policy.admit(cap); }
    return cap;
  }
  source(cap: TurnAdmission): SourceContext {
    const admitted = this.admissions.get(cap); if (!admitted) throw new Error('invalid_admission');
    return Object.freeze({ admission: cap, attachment: admitted.host.attachment });
  }
  private retire(cap: TurnAdmission) {
    const state = this.admissions.get(cap); if (!state) return;
    if (state.active) this.liveAdmissions--;
    state.active = false; state.items.clear(); state.regions.clear(); state.snapshotScalars = 0; state.snapshots.clear(); state.streamed.clear(); this.attachments.get(state.host.attachment)?.admissions.delete(cap); this.policy.retire(cap);
  }
  masked(source: SourceContext | undefined): boolean { return source?.admission ? this.admissions.get(source.admission)?.masked ?? true : true; }
  cancel(cap: TurnAdmission): readonly AudienceEmission[] { this.policy.finish(cap, 'cancel'); this.retire(cap); return []; }
  detach(attachment: AttachmentCapability): readonly AudienceEmission[] {
    const state = this.attachments.get(attachment); if (!state) return [];
    state.active = false; for (const cap of state.admissions) this.cancel(cap); state.admissions.clear(); return [];
  }
  intake(event: ExecutionEvent, source: SourceContext | undefined): IntakeResult {
    const charge = chargeExecutionEvent(event);
    const admission = source?.admission;
    const admitted = admission ? this.admissions.get(admission) : undefined;
    const attachment = source ? this.attachments.get(source.attachment) : undefined;
    const valid = Boolean(admitted?.active && attachment?.active && source?.attachment === admitted.host.attachment);
    const ordinal = ++this.ordinal;
    const envelope: HostEnvelope = Object.freeze({ eventId: `${this.incarnation}-${ordinal}`, instanceId: admitted?.host.instanceId ?? 'unowned', threadId: admitted?.host.threadId ?? 'unowned', generation: admitted?.generation ?? 0, intakeOrdinal: ordinal, createdAt: Date.now() });
    let emission = 0;
    const emit = (event: AudienceEvent): AudienceEmission => freeze({ envelope, emissionId: `${envelope.eventId}-${emission++}`, event });
    const omitted = () => emit({ type: 'audience.omitted', eventId: envelope.eventId, threadId: envelope.threadId, generation: envelope.generation, reason: 'redacted', text: MARKER });
    const skeleton = { eventId: envelope.eventId, threadId: envelope.threadId, providerInstanceId: envelope.instanceId, createdAt: new Date(envelope.createdAt).toISOString(), generation: envelope.generation, speechDisposition: 'none' as const };
    // Display exhaustion withholds text, not the fact that this admitted
    // turn is waiting. Action authority remains in the separately stored card.
    const pendingControl = (): AudienceEmission[] => {
      if (!valid) return [];
      try {
        if (own(event, 'type') !== 'request.opened') return [];
        const requestType = own(event, 'requestType');
        return requestType === 'permission' || requestType === 'question'
          ? [emit({ ...skeleton, type: 'request.opened', requestType, tool: MARKER, summary: MARKER })] : [];
      } catch { return []; } // Accessors cannot manufacture a control fact.
    };
    let terminal: 'complete' | 'exit' | undefined;
    try {
      const type = own(event, 'type');
      terminal = type === 'turn.completed' ? 'complete' : type === 'session.exited' ? 'exit' : undefined;
      if (charge.oversize || !valid) {
        if (admitted) admitted.masked = true;
        if (admission) this.policy.retire(admission);
        const audience = [omitted(), ...pendingControl()];
        if (terminal || type === 'request.resolved' || type === 'runtime.error') audience.push(emit({ ...skeleton, type, ...(type === 'runtime.error' ? { message: MARKER } : {}) } as AudienceEvent));
        return { execution: event, audience };
      }
      const rawItem = own(event, 'itemId');
      let item = '';
      if (typeof rawItem === 'string' && rawItem.length > 0 && rawItem.length <= 1024) {
        item = admitted!.items.get(rawItem) ?? '';
        if (!item) {
          if (admitted!.items.size >= TURN_ITEM_LIMIT) { admitted!.masked = true; this.policy.retire(admission!); return { execution: event, audience: [omitted(), ...pendingControl()] }; }
          item = `${admitted!.generation}-${admitted!.items.size}`; admitted!.items.set(rawItem, item);
        }
      }
      const kind = own(event, 'streamKind') ?? own(event, 'itemType') ?? type;
      // A completed anonymous assistant item closes its display region. The
      // next item has a new host identity, while the policy still checks the
      // shared assistant context across items and retains its turn limits.
      const anonymous = kind === 'assistant_text' ? `anonymous-${admitted!.anonymousAssistant}` : 'anonymous';
      const stream = `${item || anonymous}:${kind === 'reasoning_text' || kind === 'reasoning' ? 'reasoning' : kind === 'assistant_text' ? 'assistant' : 'other'}`;
      if (!item && type === 'item.completed' && kind === 'assistant_text') {
        // The retired policy needs no new anonymous region. Other event types
        // still project their control shape, including opaque question choices.
        if (admitted!.masked || admitted!.anonymousAssistant >= TURN_ITEM_LIMIT) {
          admitted!.masked = true; this.policy.retire(admission!);
          return { execution: event, audience: [omitted(), ...pendingControl()] };
        }
        admitted!.anonymousAssistant++;
      }
      const { batch, shape } = extract(event, envelope, stream);
      if (type === 'content.delta') {
        if (!admitted!.streamed.has(stream) && admitted!.streamed.size >= DISPLAY_STREAM_LIMIT) throw new Error('stream budget');
        admitted!.streamed.add(stream);
      }
      const decisions: PolicyDecision[] = [];
      if (type === 'content.reset') {
        admitted!.snapshotScalars -= admitted!.snapshots.get(stream)?.text.length ?? 0;
        admitted!.snapshots.delete(stream);
      }
      if (type === 'content.reset') decisions.push(this.policy.reset(admission, stream));
      decisions.push(this.policy.consume(admission, batch));
      // F2 consumes a terminal batch atomically, including its buffered tail.
      // Calling finish again here would turn an already retired CLEAN result into MASKED.
      if (decisions.some(d => d.exhausted)) { admitted!.masked = true; return { execution: event, audience: [omitted(), ...pendingControl(), ...(terminal ? [emit({ ...skeleton, type } as AudienceEvent)] : [])] }; }
      admitted!.masked ||= decisions.some(decision => decision.masked || decision.exhausted);
      const operations = decisions.flatMap(d => d.operations);
      const audience: AudienceEmission[] = [];
      // Buffered carriers can flush on another event or terminal. They remain
      // separate emissions, ordered ahead of the current terminal skeleton.
      for (const op of operations) {
        if (op.path !== 'delta' && op.path !== 'text') { fill(shape, op.path, op.text); continue; }
        const previous = admitted!.snapshots.get(op.stream)?.text ?? '';
        const cumulative = op.op === 'replace' || op.op === 'omit' ? op.text : previous + op.text;
        const snapshotScalars = admitted!.snapshotScalars - previous.length + cumulative.length;
        if (cumulative.length > SNAPSHOT_SCALAR_LIMIT || snapshotScalars > TURN_SNAPSHOT_SCALAR_LIMIT ||
            (!admitted!.snapshots.has(op.stream) && admitted!.snapshots.size >= DISPLAY_STREAM_LIMIT)) {
          admitted!.masked = true; this.policy.retire(admission!); return { execution: event, audience: [omitted(), ...pendingControl()] };
        }
        admitted!.snapshotScalars = snapshotScalars;
        admitted!.snapshots.set(op.stream, { text: cumulative, regionId: op.regionId, revision: op.revision, speech: op.speech });
        const same = batch.carriers.some(c => c.path === op.path && c.stream === op.stream);
        if (same && type !== 'content.delta') {
          fill(shape, op.path, cumulative);
          shape.regionId = op.regionId; shape.itemRevision = op.revision;
          shape.speechDisposition = op.speech;
          if (!admitted!.streamed.has(op.stream)) continue;
        }
        if (op.op === 'omit') {
          if (admitted!.regions.has(op.regionId)) continue;
          if (admitted!.regions.size >= 64) { audience.push(omitted()); continue; }
          admitted!.regions.add(op.regionId);
        }
        // A deferred release belongs to its original item, even on another item's completion.
        const releasedItem = op.stream.slice(0, op.stream.lastIndexOf(':'));
        const identity = { ...skeleton, ...(!releasedItem.startsWith('anonymous') ? { itemId: releasedItem } : {}), streamKind: op.stream.endsWith(':reasoning') ? 'reasoning_text' as const : 'assistant_text' as const, regionId: op.regionId, itemRevision: op.revision };
        if (op.op === 'replace' && admitted!.streamed.has(op.stream)) audience.push(emit({ ...identity, type: 'content.reset' }));
        audience.push(emit({ ...identity, type: 'content.delta', delta: op.text, speechDisposition: op.speech }));
      }
      if (type === 'item.completed' && kind === 'assistant_text') {
        const snapshot = admitted!.snapshots.get(stream);
        if (snapshot) {
          shape.text = snapshot.text; shape.regionId = snapshot.regionId;
          shape.itemRevision = snapshot.revision; shape.speechDisposition = snapshot.speech;
        }
      }
      if (decisions.some(d => d.masked) && Array.isArray(shape.questions)) {
        for (const q of shape.questions as { options: { label: string }[] }[]) q.options.forEach((option, i) => { option.label = `Option ${i + 1}`; });
      }
      if (type !== 'content.delta') audience.push(emit({ ...skeleton, ...(item ? { itemId: item } : {}), ...shape } as AudienceEvent));
      return { execution: event, audience };
    } catch {
      if (admitted) admitted.masked = true;
      if (admission) this.policy.retire(admission);
      return { execution: event, audience: [omitted(), ...pendingControl(), ...(terminal ? [emit({ ...skeleton, type: terminal === 'complete' ? 'turn.completed' : 'session.exited' } as AudienceEvent)] : [])] };
    } finally { if (terminal && admission) this.retire(admission); }
  }
}
