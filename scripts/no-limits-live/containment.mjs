import { connect } from 'node:net';
import { existsSync } from 'node:fs';
/** A diagnostic only. A dead endpoint or timeout cannot establish enforcement.
 * This runner has no trusted provisioner attestation; it cannot certify an
 * API allowlist from command arguments or a failed connection. */
export async function negativeEgressProbe({ host = '192.0.2.1', port = 443, allowlist = [] } = {}) {
 if (allowlist.includes(host)) throw Error('negative probe target is allowlisted');
 const at = Date.now();
 return new Promise(resolve => {
  const socket = connect({ host, port }); let finished = false;
  const done = (blocked, reason) => { if (finished) return; finished = true; socket.destroy(); resolve({ attempted: true, host, port, blocked, reason, at, durationMs: Date.now() - at }); };
  socket.once('connect', () => done(false, 'connected')); socket.once('error', e => done(['EACCES', 'EPERM', 'ENETUNREACH'].includes(e.code), e.code ?? 'error'));
  socket.setTimeout(2000, () => done(false, 'timeout'));
 });
}
export async function containmentReport(allowlist) {
 return { container: existsSync('/.dockerenv'), network: 'unverified', allowlist, probe: await negativeEgressProbe({ allowlist }) };
}
