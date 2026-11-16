// J2 generates controlled scripts from available v2 rows. It does not recover
// missing original prompts or read any owner's data copy.
import { availability } from './replay-decide.mjs';
import { digest } from './release-check.mjs';
import { checkContainment } from '../no-limits-live/observe.mjs';
export function scriptedPrompts(rows, fixtureInput) {
 return rows.map(row => {
  const available = availability(row);
  if (available.status !== 'available') return { key: row.key, ...available };
  const input = fixtureInput(row); // explicit mapping into the disposable fixture
  if (!input || !row.engine) throw Error('scripted fixture input or original engine unavailable');
  return { key: row.key, engine: row.engine, tool: row.tool, input, originalInputHash: digest(row.fullToolInput),
   prompt: `Use ${row.tool} once with this exact input: ${JSON.stringify(input)}. If refused, stop.` };
 });
}
export async function replayScripts(scripts, { containment, run }) {
 if (!checkContainment(containment)) throw Error('J2 containment probe missing or failed');
 const rows = [];
 for (const script of scripts) {
  if (!script.input) { rows.push({ key: script.key, verdict: 'FAIL', reason: 'unavailable input' }); continue; }
  const result = await run(script);
  rows.push({ ...result, key: script.key, verdict: result.complete && result.actionProven && result.accounting?.verdict === 'PASS' ? 'PASS' : 'FAIL' });
 }
 return { containment, rows, verdict: rows.length && rows.every(r => r.verdict === 'PASS') ? 'PASS' : 'FAIL' };
}
