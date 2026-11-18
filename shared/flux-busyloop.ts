// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Faithful port of busyloop_spec.py (d38a0661…), refusal-contract-A2.2.
// Table order is contractual. The tests read the pinned TSV directly.
export type Endpoint = "chat" | "resp" | "msg";
export type Action = "STOP" | "PAUSE" | "BACKOFF" | "RETRY_ONCE" | "PASS";
export type Wait = number | "-" | "ladder" | `reset+${number}`;
export type Reason = "keyRevoked" | "keyNotFound" | "keyAccess" | "accessUnknown" | "accountCeiling" | "keyBudget" | "keyTokens" | "botBudget" | "keyLifetime" | "freeCap" | "freeCredit" | "requestCap" | "planCap" | "planAllowance" | "credit" | "creditHold" | "unresolved" | "spendCap" | "hourly" | "fluxStop" | "keyRefused" | "unknownLimit" | "hold" | "busy" | "other";
export interface Decision { reason: Reason; action: Action; wait: Wait }
export interface Signals { endpoint: Endpoint; status: number; codes: string[]; limit?: string; text: string; wait?: number; holdHeader: boolean }
type TextRule = readonly [readonly string[], Reason];
const FINAL_ORDER: ReadonlyArray<readonly [string, Reason]> = [["key_revoked", "keyRevoked"], ["key_not_found", "keyNotFound"], ["entitlement_missing", "keyAccess"], ["subscription_account_mismatch", "keyAccess"], ["authorization_state_unknown", "accessUnknown"], ["account_monthly_budget_exhausted", "accountCeiling"], ["key_budget_reached", "keyBudget"], ["key_lifetime_cap_exhausted", "keyLifetime"], ["free_cap_reached", "freeCap"], ["free_tier_exhausted", "freeCredit"], ["builder_auto_bump_eligible", "requestCap"], ["cap_reached", "planCap"], ["credit_exhausted", "credit"], ["credit_hold", "creditHold"], ["credit_unresolved", "unresolved"], ["monthly_cap", "spendCap"], ["daily_cap", "spendCap"], ["hourly_burn_limit", "hourly"]];
const OVERRIDE_TEXT: readonly TextRule[] = [[["Free tier monthly allowance exhausted. Upgrade to Builder"], "fluxStop"], [["plan allowance", "paused until"], "planAllowance"], [["overage cap"], "spendCap"], [["$1 free credit is used up"], "freeCredit"]];
const TEXT_RULES: readonly TextRule[] = [[["monthly free-tier token allowance"], "freeCap"], [["10M request cap reached"], "requestCap"], [["Monthly cap reached"], "planCap"], [["API key has been revoked"], "keyRevoked"], [["no active Flux entitlement"], "keyAccess"], [["does not resolve to this account"], "keyAccess"], [["No Flux key record"], "keyNotFound"], [["entitlement state could not be interpreted"], "accessUnknown"], [["bot has reached its"], "botBudget"], [["token monthly limit"], "keyTokens"], [["monthly budget"], "keyBudget"], [["lifetime spend cap"], "keyLifetime"], [["monthly spend ceiling"], "accountCeiling"], [["credit balance is exhausted"], "credit"], [["Cloud credit is exhausted"], "credit"], [["credit is on hold"], "creditHold"], [["could not be verified"], "unresolved"], [["spend cap is reached"], "spendCap"]];
const LIMIT_SUBTYPE: Readonly<Record<string, Reason>> = {"monthly_spend": "keyBudget", "monthly_tokens": "keyTokens", "bot_monthly_spend": "botBudget"};
const SUBTYPE_TEXT: readonly string[] = ["botBudget", "keyTokens", "keyBudget"];
const HOLD_TEXT: readonly string[] = ["temporarily reserved"];
const RATE_TEXT: readonly string[] = ["RateLimitError", "Rate limit", "No deployments available", "Limit resets at", "retry shortly"];
const HOLD_CODES = new Set(["concurrency"]);
const TRANSIENT_CODES = new Set(["batch_concurrency", "batch_rate", "billing_system_degraded", "key_rate_limit", "model_cooling_down", "provider_rate_limited", "tier_rpm_limit"]);
const TERMINAL_STATUS = new Set([401, 402, 403]);
const FLUX_FINAL = new Set(FINAL_ORDER.map(([code]) => code));
const VOCAB = new Set([...FLUX_FINAL, ...HOLD_CODES, ...TRANSIENT_CODES]);
export const REFUSAL_REASONS: ReadonlySet<string> = new Set([...FINAL_ORDER.map(([, r]) => r), ...TEXT_RULES.map(([, r]) => r), ...OVERRIDE_TEXT.map(([, r]) => r), 'keyTokens', 'botBudget', 'keyRefused', 'unknownLimit', 'hold', 'busy']);
const WAIT_PATTERNS = [/Retry in (\d+)s/, /Retry after (\d+) seconds?/, /[Tt]ry again in (\d+) ?s(?:econds)?/];
export const dict = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const slug = (v: unknown): string | undefined => typeof v === 'string' && /^[a-z0-9_:-]{1,64}$/.test(v) ? v : undefined;
const wireWait = (v: unknown): number | undefined => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 7200 ? v : undefined;
const headerWait = (v: unknown): number | undefined => typeof v === 'string' && /^[0-9]+$/.test(v) && Number(v) <= 7200 ? Number(v) : undefined;
const firstTextReason = (text: string, rules: readonly TextRule[]): Reason | undefined => rules.find(([needles]) => needles.every(n => text.includes(n)))?.[1];
function textWait(text: string, now: number): number | undefined {
  for (const p of WAIT_PATTERNS) { const m = p.exec(text); if (m) return Number(m[1]); }
  const m = /Limit resets at: (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC/.exec(text);
  if (m) { const d = Math.trunc((Date.parse(m[1].replace(' ', 'T') + 'Z') - now) / 1000); if (d > 0) return d; }
  return undefined;
}
const clampWait = (wait: number | undefined) => wait === undefined ? undefined : Math.max(1, Math.min(7200, wait));
export function extract(endpoint: Endpoint, status: number, headers: Record<string, unknown> | undefined, body: unknown, now = Date.now()): Signals {
  // Fetch combines duplicate fields with commas. Preserve every hold signal;
  // FINAL_ORDER, not wire order, chooses the most terminal reason.
  const h: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const k = key.toLowerCase();
    h[k] = k in h ? `${h[k]}, ${value}` : value;
  }
  const holdParts = typeof h['x-flux-hold-reason'] === 'string' ? h['x-flux-hold-reason'].split(',').map(s => s.trim()) : [];
  const waits = typeof h['retry-after'] === 'string' ? h['retry-after'].split(',').map(s => headerWait(s.trim())) : [];
  // Equal duplicates collapse; conflicting valid waits use the longest delay.
  const retryAfter = waits.length && waits.every(v => v !== undefined) ? Math.max(...waits as number[]) : undefined;
  const e = dict(dict(body).error), psf = dict(e.provider_specific_fields), pe = psf.error, ped = dict(pe);
  const codes: string[] = [];
  for (const value of [...holdParts, e.state, e.error, typeof e.code === 'string' && !/^\d+$/.test(e.code) ? e.code : undefined, e.type, typeof pe === 'string' ? pe : undefined, ped.state, ped.type, ped.error]) {
    const s = slug(value); if (s && VOCAB.has(s) && !codes.includes(s)) codes.push(s);
  }
  const limit = slug(e.limit) ?? slug(psf.limit) ?? slug(ped.limit);
  const text = [e.message, psf.message, ped.message].filter(t => typeof t === 'string').join('\n');
  const wait = retryAfter ?? wireWait(e.retry_after) ?? wireWait(psf.retry_after) ?? wireWait(ped.retry_after) ?? textWait(text, now);
  return { endpoint, status, codes, limit, text, wait: clampWait(wait), holdHeader: 'x-flux-hold-reason' in h };
}
export function signalsFromUpstream(upstream: unknown, text: string, now = Date.now()): Signals {
  const u = dict(upstream), codes: string[] = [];
  const listed = Array.isArray(u.codes) ? u.codes : [];
  for (const value of [u.hold_reason, ...listed, u.state, u.code, u.type]) { const s = slug(value); if (s && VOCAB.has(s) && !codes.includes(s)) codes.push(s); }
  return { endpoint: 'resp', status: typeof u.http_status === 'number' ? u.http_status : 0, codes, limit: slug(u.limit), text, wait: clampWait(wireWait(u.retry_after_s) ?? textWait(text, now)), holdHeader: 'hold_reason' in u };
}
function keyBudgetSubtype(s: Signals): Reason {
  if (s.limit && Object.hasOwn(LIMIT_SUBTYPE, s.limit)) return LIMIT_SUBTYPE[s.limit];
  const t = firstTextReason(s.text, TEXT_RULES);
  return t && SUBTYPE_TEXT.includes(t) ? t : 'keyBudget';
}
function stopReason(s: Signals): Reason {
  if (s.endpoint === 'chat' && s.codes.includes('free_tier_exhausted') && !s.holdHeader) return 'fluxStop';
  const override = firstTextReason(s.text, OVERRIDE_TEXT); if (override) return override;
  for (const [code, reason] of FINAL_ORDER) if (s.codes.includes(code)) return code === 'key_budget_reached' ? keyBudgetSubtype(s) : reason;
  return firstTextReason(s.text, TEXT_RULES) ?? ([401, 403].includes(s.status) ? 'keyRefused' : 'fluxStop');
}
type Step = (s: Signals) => [Action, number | 'ladder' | undefined] | undefined;
const terminalStatus: Step = s => TERMINAL_STATUS.has(s.status) ? ['STOP', undefined] : undefined;
const finalCode: Step = s => s.codes.some(c => FLUX_FINAL.has(c)) ? ['STOP', undefined] : undefined;
const terminalText: Step = s => firstTextReason(s.text, OVERRIDE_TEXT) || firstTextReason(s.text, TEXT_RULES) ? ['STOP', undefined] : undefined;
const held = (s: Signals) => s.codes.some(c => HOLD_CODES.has(c)) || HOLD_TEXT.some(t => s.text.includes(t));
const hold: Step = s => held(s) ? ['RETRY_ONCE', s.wait ?? 2] : undefined;
const transient: Step = s => s.codes.some(c => TRANSIENT_CODES.has(c)) || RATE_TEXT.some(t => s.text.includes(t)) ? ['BACKOFF', s.wait ?? 'ladder'] : undefined;
const knownWait: Step = s => s.status === 429 && s.wait !== undefined ? ['BACKOFF', s.wait] : undefined;
const unknown429: Step = s => s.status === 429 ? ['PAUSE', undefined] : undefined;
const serverError: Step = s => s.status >= 500 ? ['RETRY_ONCE', s.wait ?? 2] : undefined;
const ACTION_STEPS = [terminalStatus, finalCode, terminalText, hold, transient, knownWait, unknown429, serverError];
export function decide(s: Signals): Decision {
  let action: Action = 'PASS', wait: number | 'ladder' | undefined;
  for (const step of ACTION_STEPS) { const got = step(s); if (got) { [action, wait] = got; break; } }
  if (action === 'STOP') { const reason = stopReason(s); return { reason, action, wait: reason === 'hourly' && s.wait !== undefined ? `reset+${s.wait}` : '-' }; }
  if (action === 'PAUSE') return { reason: 'unknownLimit', action, wait: '-' };
  if (action === 'RETRY_ONCE') return { reason: held(s) ? 'hold' : 'busy', action, wait: wait! };
  if (action === 'BACKOFF') return { reason: 'busy', action, wait: wait! };
  return { reason: 'other', action: 'PASS', wait: '-' };
}
export function classify(endpoint: Endpoint, status: number, headers: Record<string, unknown> | undefined, body: unknown, now = Date.now()): Decision {
  return decide(extract(endpoint, status, headers, body, now));
}
export const isTerminal = (d: Decision | undefined): boolean => d?.action === 'STOP' || d?.action === 'PAUSE';
export const keyRejectedMark = (d: Decision): boolean => d.reason === 'keyRevoked';

export type PromptState = 'OPEN' | 'AUTH_REFRESH' | 'REFRESHED' | 'TERMINAL' | 'DONE';
export type DispatchKind = 'main' | 'side' | 'sampler_retry' | 'refresh_resubmit' | 'provider_4c' | 'transient_4d' | 'compact' | 'resume';
export function refreshEligible(status: number, result: Decision, refreshable: boolean): boolean {
  return refreshable && status === 401 && result.reason === 'keyRefused' && result.action === 'STOP' && result.wait === '-';
}
/** A2.2 prompt state machine. Counts dispatches, including changed models/bodies.
 * Murage's submission guard uses static-key mode; the engine owns token refresh. */
export class PromptSM {
  state: PromptState = 'OPEN';
  dispatches = 0;
  afterTerminal = 0;
  main = 0;
  side = 0;
  refreshes = 0;
  resubmits = 0;
  violations: string[] = [];
  readonly refreshable: boolean;
  constructor(refreshable: boolean) { this.refreshable = refreshable; }
  dispatch(kind: DispatchKind, _key?: string): void {
    this.dispatches++;
    if (this.state === 'TERMINAL') { this.afterTerminal++; this.violations.push(`${kind} dispatched after terminal`); return; }
    if (kind === 'main') { if (++this.main > 1) this.violations.push('second main dispatch'); }
    else if (kind === 'side') { if (++this.side > 1) this.violations.push('second side dispatch'); }
    else if (kind === 'refresh_resubmit') {
      if (this.state !== 'REFRESHED') this.violations.push('resubmit without an eligible refresh');
      if (++this.resubmits > 1) this.violations.push('second resubmit');
    } else if (this.state === 'AUTH_REFRESH' || this.state === 'REFRESHED') this.violations.push(`${kind} during the auth refresh exception`);
  }
  refreshToken(): void {
    if (this.state !== 'AUTH_REFRESH') { this.violations.push(`token refresh in state ${this.state}`); return; }
    this.refreshes++;
    this.state = 'REFRESHED';
  }
  respond(kind: DispatchKind, status: number, result?: Decision | null): void {
    if (kind === 'side') return;
    if (result == null) { this.state = 'DONE'; return; }
    if (kind === 'refresh_resubmit') { this.state = 'TERMINAL'; return; }
    if (isTerminal(result)) {
      if (this.state === 'OPEN' && this.refreshes < 1 && refreshEligible(status, result, this.refreshable)) this.state = 'AUTH_REFRESH';
      else this.state = 'TERMINAL';
    }
  }
  verdict(): [string, number, PromptState] { return [this.violations.length ? 'violation' : 'ok', this.dispatches, this.state]; }
}
