// Inert differential reader worker. No payload is executed or imported.
import { createInterface } from 'node:readline';
import { judge, readCode } from '../server/no-limits-code.ts';
import { finalDecision } from '../shared/no-limits-decision.ts';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const rows = JSON.parse(line);
  const results = rows.map((row: { identity: string; payload: unknown; mode?: string }) => {
    const port = judge(row.identity, row.payload, row.mode);
    const gate = finalDecision(readCode(row.identity, row.payload, row.mode).reads);
    if (port.verdict !== gate.verdict || port.cls !== gate.cls) throw new Error('port/gate divergence');
    return port.cls ? `card:${port.cls}` : 'run';
  });
  process.stdout.write(JSON.stringify(results) + '\n');
}
