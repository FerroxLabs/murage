import { registerBusyloopPayloadSite } from "../../shared/flux-route.ts";
// Boundary adapters for refusal-contract-A2.1. Read before display sanitization.
import { classify, decide, dict, signalsFromUpstream, type Decision, type Endpoint } from '../../shared/flux-busyloop.ts';
import { fluxRefusalCode, refusalHttpStatus } from '../flux-refusal.ts';
import { readFluxJson } from './flux-json-reader.ts';

type FluxResponse = { endpoint?: Endpoint; status: number; headers?: Headers; body?: unknown } | { upstream: unknown; message: string };
/** The single decision entry for HTTP envelopes, parsed stream frames and ACP
 * projections. Call before display truncation, recovery, retry or dispatch. */
export function fluxResponseDecision(response: FluxResponse, now = Date.now()): Decision {
  return 'upstream' in response
    ? decide(signalsFromUpstream(response.upstream, response.message, now))
    : classify(response.endpoint ?? 'chat', response.status, response.headers ? Object.fromEntries(response.headers) : {}, response.body, now);
}
export async function inspectFluxResponse(response: Response, routed: boolean, signal?: AbortSignal, jsonBody = false): Promise<{ decision?: Decision; rawBody?: string; bytes?: number }> {
  if (!routed) return {};
  let rawBody: string | undefined, bytes: number | undefined, body: unknown, unreadable = false;
  if (!response.ok || jsonBody) {
    try { ({rawBody, bytes} = await readFluxJson(response, signal, !response.ok)); } catch { unreadable = true; }
    if (rawBody) { try { body = registerBusyloopPayloadSite("read", JSON.parse(rawBody)); } catch { /* status/header evidence still applies */ } }
  }
  const decision = fluxResponseDecision(registerBusyloopPayloadSite("classify", { status: response.status, headers: response.headers, body }));
  // Resource/read limits must never turn unobserved terminal fields into retry.
  if (unreadable && decision.action !== 'STOP') return { rawBody, decision: {reason:'unknownLimit', action:'PAUSE', wait:'-'} };
  return { decision, rawBody, bytes };
}
export function chatRefusal(status: number, headers: Headers, rawBody: string, now = Date.now()): Decision {
  let body: unknown;
  try { body = registerBusyloopPayloadSite("read", JSON.parse(rawBody)); } catch { /* lost body: status alone */ }
  return fluxResponseDecision(registerBusyloopPayloadSite("classify", { status, headers, body }), now);
}
export function claudeRefusal(text: string, now = Date.now()): Decision | undefined {
  const match = /API Error:\s*(\d{3})\b/.exec(text);
  if (!match) return;
  let body: unknown;
  const start = text.indexOf('{');
  if (start >= 0) { try { body = registerBusyloopPayloadSite("read", JSON.parse(text.slice(start))); } catch { /* status-only fallback */ } }
  return fluxResponseDecision(registerBusyloopPayloadSite("classify", {endpoint:'msg', status:Number(match[1]), body}), now);
}
export function acpRefusal(data: unknown, rpcCode?: unknown, message = '', now = Date.now()): Decision | undefined {
  const d = dict(data), u = dict(d.upstream);
  const typed = typeof u.http_status === 'number' && Number.isInteger(u.http_status) && u.http_status >= 100 && u.http_status < 600;
  const status = typed ? u.http_status as number : refusalHttpStatus(d, message) ?? (rpcCode === -32003 || d.error_kind === 'rate_limited' ? 429 : /auth_required|authentication required/i.test(message) ? 401 : undefined);
  const text = typeof d.message === 'string' ? d.message : typeof d.reason === 'string' ? d.reason : message;
  // Fuigo 1.0.41 can retain only a slug fragment or defensive legacy data.
  // The new wire is authoritative; this compatibility scan never reads a valid typed envelope.
  const legacy = typed ? undefined : fluxRefusalCode(data, message);
  const code = legacy === 'hold' ? 'concurrency' : legacy;
  const decision = fluxResponseDecision(registerBusyloopPayloadSite("classify", { upstream: { ...(code ? { code } : {}), ...u, http_status: status ?? 0 }, message: text }), now);
  return status === undefined && decision.action === 'PASS' ? undefined : decision;
}
/** Copy-only reset date. It never changes retry policy or the spec's wait. */
export function refusalResetAt(decision: Decision | undefined, source: unknown, now = Date.now()): number | undefined {
  if (decision?.reason === 'hourly' && typeof decision.wait === 'string' && decision.wait.startsWith('reset+')) return now + Number(decision.wait.slice(6)) * 1000;
  const d = dict(source), e = dict(d.error), p = dict(e.provider_specific_fields), u = dict(d.upstream);
  for (const value of [u.resets_at, e.resets_at, p.resets_at]) {
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) { const at = Date.parse(value); if (Number.isFinite(at)) return at; }
  }
  const text = [d.message, d.reason, e.message, p.message].filter(t => typeof t === 'string').join('\n');
  const explicit = /It resets on (\d{1,2} [A-Z][a-z]+ \d{4})/.exec(text);
  if (explicit) { const at = Date.parse(explicit[1] + ' 00:00:00 UTC'); if (Number.isFinite(at)) return at; }
  const paused = /paused until (\d{1,2} [A-Z][a-z]+)/.exec(text);
  if (paused) {
    const year = new Date(now).getUTCFullYear();
    const at = Date.parse(paused[1] + ' ' + year + ' 00:00:00 UTC');
    if (Number.isFinite(at)) return at >= now ? at : Date.parse(paused[1] + ' ' + (year + 1) + ' 00:00:00 UTC');
  }
  return undefined;
}

/** Codex and headless CLI error envelopes may wrap the HTTP body in data or
 * httpConnectionFailed. Inspect those structures before display text is cut. */
export function cliRefusal(source: unknown, now = Date.now()): { decision: Decision; status: number; body: unknown } {
  let status = 0, textStatus = 0;
  let headers: Headers | undefined;
  const bodies: unknown[] = [], texts: string[] = [];
  let upstream: Record<string, unknown> | undefined;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') {
      texts.push(value);
      const match = /(?:API Error:|HTTP(?: error:| status)?|unexpected status)\s*(\d{3})\b/i.exec(value);
      if (!textStatus && match) textStatus = Number(match[1]);
      const start = value.indexOf('{');
      if (start >= 0) { try { const body = registerBusyloopPayloadSite("read", JSON.parse(value.slice(start))); bodies.push(body); visit(body, depth + 1); } catch { /* plain error text */ } }
      return;
    }
    const object = dict(value);
    if (!headers && Object.keys(dict(object.headers)).length) {
      try { headers = new Headers(Object.fromEntries(Object.entries(dict(object.headers)).filter((entry): entry is [string,string]=>typeof entry[1] === 'string'))); } catch { /* malformed metadata; status/body remain authoritative */ }
    }
    if (typeof dict(object.upstream).http_status === 'number') upstream ??= object;
    for (const key of ['http_status', 'status', 'statusCode', 'httpStatus', 'httpStatusCode']) {
      const v = object[key];
      if (!status && typeof v === 'number' && Number.isInteger(v) && v >= 100 && v < 600) status = v;
    }
    if (object.error && typeof object.error === 'object') bodies.push(object);
    if ('state' in object || 'code' in object || 'provider_specific_fields' in object) bodies.push({error:object});
    if (value instanceof Error) visit(value.message, depth + 1);
    for (const key of ['body', 'data', 'error', 'message', 'codexErrorInfo', 'httpConnectionFailed']) {
      if (key === 'body' && object[key] && typeof object[key] === 'object') bodies.push(object[key]);
      if (key in object) visit(object[key], depth + 1);
    }
  };
  visit(source, 0);
  status ||= textStatus;
  if (upstream) return {decision:fluxResponseDecision(registerBusyloopPayloadSite("classify", {upstream:upstream.upstream,message:typeof upstream.message === 'string' ? upstream.message : texts.join('\n')}), now),status:dict(upstream.upstream).http_status as number,body:upstream};
  bodies.push({error:{message:texts.join('\n')}});
  const observed = bodies.map(body=>({body, decision:fluxResponseDecision(registerBusyloopPayloadSite("classify", {endpoint:'resp',status:0,headers,body}), now)}));
  // Choose the complete body bearing the strongest evidence, then apply the
  // actual status (a 401/402/403 still wins over a transient body signal).
  const selected = observed.find(v=>v.decision.action==='STOP') ?? observed.find(v=>v.decision.action!=='PASS') ?? observed[0];
  return {decision:fluxResponseDecision(registerBusyloopPayloadSite("classify", {endpoint:'resp',status,headers,body:selected.body}), now),status,body:selected.body};
}
