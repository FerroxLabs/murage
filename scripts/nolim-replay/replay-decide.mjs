// J1 is policy on recorded input, not proof of actor dispatch wiring. The
// integrated testing/replay-source supplies openRequest on an isolated store.
export function replayActor(row) {
 const label = row.label;
 if (!label?.independent || !['owner','owner-routine','webhook','owner-channel','owner-phone','other','guest','non-owner'].includes(label.actor)) throw Error('ACTOR_LABEL_UNAVAILABLE');
 return { kind: label.actor, via: label.via ?? (label.actor === 'owner' ? 'owner-typed' : label.actor === 'owner-routine' ? 'routine-run' : 'other') };
}
export function parityRequired(row) {
 const actor=replayActor(row).kind;
 const nonOwner=['other','guest','non-owner'].includes(actor);
 return row.level !== 'unlimited' || nonOwner && !(row.label.permissionExplicit === true && typeof row.label.origin === 'string' && row.label.origin.length>0);
}
export function freezeSnapshot(value) {
 const copy = structuredClone(value);
 const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
 freeze(copy); return copy;
}
export function availability(row) {
 const shape = typeof row.tool === 'string' && /^[\w.-]{1,120}$/.test(row.tool) ? row.tool : 'unknown-tool';
 const texts = [row.card?.subtitle, row.card?.toolInput, row.subtitle, row.toolInput, row.boundedToolInput, JSON.stringify(row.fullToolInput)].filter(x => typeof x === 'string');
 // These are the persisted cap markers, rather than caller-supplied flags.
 const cut = /…\[\d+ bytes more\]|\[truncated(?:, \d+ (?:bytes|characters) more)?\]|…\[truncated\]/i;
 const masked = /\[REDACTED[^\]]*\]|<redacted>|«redacted \d+ chars»|\*{3,}/i;
 const unavailable = reason => {
  const inputShape = reason === 'unavailable:context' ? 'context'
   : row.redacted || texts.some(s => masked.test(s)) ? 'redacted'
   : row.truncated || row.toolInputTruncated || texts.some(s => cut.test(s)) ? (texts.some(s => /<<-?\s*['"\w]/.test(s)) ? 'long-heredoc' : 'truncated')
   : 'missing-input';
  return { status: 'unavailable', shape, inputShape, reason, requiredLiveRow: `unavailable-${shape}-${inputShape}` };
 };
 if (!Object.hasOwn(row, 'fullToolInput') || row.fullToolInput == null || row.toolInputMissing || row.toolInputTruncated || row.truncated || row.redacted
   || texts.some(s => cut.test(s)) || texts.some(s => masked.test(s))) return unavailable('unavailable:input');
 const source = row.cardClass?.refusalSource ?? row.cardClass?.denySource ?? row.card?.cardClass?.refusalSource ?? row.card?.cardClass?.denySource;
 const contextSource = ['host-computer-declined','browser-never','app-access-denied'].includes(source);
 const contextNeeded = row.contextRequired?.length || row.label?.kind === 'needs-context'
   || /host|computer|browser|app|connector/i.test(row.tool ?? '')
   || ['host-computer-declined','browser-never','app-access-denied'].includes(row.label?.source);
 if (contextNeeded && !row.denySnapshot && !contextSource) return unavailable('unavailable:context');
 return { status: 'available', shape };
}
export async function replayDecide(row, production) {
 if (!row.key?.threadId || !row.key?.requestId || !row.key?.botId || !row.key?.turnId) throw Error('ROW_KEY_UNAVAILABLE');
 if (availability(row).status !== 'available') throw Error('FULL_INPUT_UNAVAILABLE');
 if (!row.denySnapshot || !row.levelFlags) throw Error('SNAPSHOT_UNAVAILABLE');
 replayActor(row);
 const snapshot = freezeSnapshot(row);
 const handle = production.openRequest({ kind: 'replay', row: snapshot, label: snapshot.label });
 const outcome = await production.decide(handle, registration => production.baseVerdict(registration));
 if (outcome.kind === 'card' || outcome.kind === 'question') await production.presentApproval(outcome.ref, { title: 'Recorded request', subtitle: 'Policy replay in an isolated fixture' });
 return outcome;
}
