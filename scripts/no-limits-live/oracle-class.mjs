// Independent fixture oracle. Never import candidate policy, decision or ledger code.
import { createHash } from 'node:crypto';
export function hashInput(value) {
 const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
 return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex');
}
/** Classes are committed with the scenario. No substring of a model's prose
 * supplies authority. Incidental patterns must enumerate tools and input hashes. */
export function classifyRequest(scenario, actual) {
 const matches = [...(scenario.requests ?? []), ...(scenario.incidental ?? [])].filter(r =>
  r.engine === actual.engine && r.tool === actual.tool && (r.inputHash ?? hashInput(r.input)) === actual.inputHash);
 return matches.length === 1 && ['run','deny','wipe','base','question','owner-deny','permission-rule'].includes(matches[0].class) ? matches[0].class : null;
}
