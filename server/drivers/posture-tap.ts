import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
/** Called only at the native mode response or replacement session acknowledgement. */
export function recordPostureAck(engine: string, providerInstanceId: string, threadId: string, generation: string,
 level: { askLevel?: boolean; noLimits?: boolean; stopLine?: boolean }, native: string) {
 if (process.env.MURAGE_GATE_TAP !== '1' || !process.env.MURAGE_DATA_DIR) return;
 appendFileSync(join(process.env.MURAGE_DATA_DIR,'nolim-protocol.ndjson'),JSON.stringify({type:'posture.ack',engine,providerInstanceId,threadId,generation,
  level:level.askLevel?'ask':level.noLimits?'unlimited':level.stopLine?'full':'auto',native,at:Date.now()})+'\n',{mode:0o600});
}
