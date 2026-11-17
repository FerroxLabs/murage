// SPDX-License-Identifier: AGPL-3.0-or-later
// Observe the real boot. This suite never installs an approval seam itself.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';

const seams = [
  ['highlevel/engine-policy.ts', 'installHighlevelEngineLedger'],
  ['decision/implementation.ts', 'installSynchronousQueueDeliveries'],
  ['bot-access.ts', 'installBotAccessApprovalAccounts'],
  ['memory/authority.ts', 'installMemoryApprovalAccess'],
  ['decision/implementation.ts', 'installEngineApprovalBuilder'],
  ['memory/send-fence.ts', 'setSendFenceDeps'],
] as const;

const observed: ReadonlyArray<readonly [string,string]> = [...seams,
  ['decision/implementation.ts','installDecisionHost'],
  ['decision/implementation.ts','recover'],
];

function observerSource() {
  const patches: Record<string, string> = {};
  for (const [file, name] of observed) {
    const url = new URL(file, import.meta.url).href;
    const source = patches[url] ?? readFileSync(fileURLToPath(url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const declaration = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration?.body) throw Error(`Missing observed production function ${name}`);
    const offset = declaration.body.getStart(ast) + 1;
    // Preserve every argument, return value and production side effect. The
    // only insertion is an observation at entry into the original function.
    const detail = name === 'setSendFenceDeps' ? ", classifier: arguments[0]?.classify?.name" : '';
    patches[url] = source.slice(0, offset) + `\nglobalThis.__testTruthBootObserve({name:${JSON.stringify(name)}${detail}, stack:new Error().stack});\n` + source.slice(offset);
  }
  return `
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
Error.stackTraceLimit = 30;
const patches = ${JSON.stringify(patches)};
globalThis.__testTruthBootObserve = row => appendFileSync(join(process.env.MURAGE_DATA_DIR, 'production-approval-boot.jsonl'), JSON.stringify(row)+'\\n');
registerHooks({load(url, context, nextLoad) { const result=nextLoad(url, context); return patches[url] === undefined ? result : {...result, source:patches[url]}; }});
`;
}

describe('production approval boot wiring (H6)', () => {
  let fixture: VerificationServer;
  const observations = () => {
    const path = join(fixture.info.dataDir, 'production-approval-boot.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {name:string; stack:string; classifier?:string}) : [];
  };
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: observerSource(), readyTimeoutMs: 120_000 });
    expect((await fetch(fixture.info.url + '/api/health')).status).toBe(200);
  }, 150_000);
  afterAll(async () => {
    if (!fixture) return;
    try {
      const directory = process.env.TEST_TRUTH_EVIDENCE_DIR;
      if (directory) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'production-approval-boot.json'), JSON.stringify({ fixture: fixture.info, observations: observations() }, null, 2));
        writeFileSync(join(directory, 'production-approval-boot.server.log'), readFileSync(fixture.info.logPath));
      }
    } finally { await fixture.close(); }
  }, 30_000);
  it('the observer sees the real production host installation and recovery', () => {
    const trace = observations();
    expect(trace.some(row => row.name === 'installDecisionHost')).toBe(true);
    expect(trace.some(row => row.name === 'recover')).toBe(true);
  });
  for (const [, name] of seams) it(`${name} is called by production boot before readiness`, () => {
    const trace = observations();
    const calls = trace.filter(row => row.name === name);
    expect(calls.length, `${name} was never called by the production server`).toBeGreaterThan(0);
    for (const call of calls) expect(call.stack).toMatch(/server[\\/](?:index|memory[\\/]dispatch)\.ts:/);
    if (name === 'setSendFenceDeps') expect(calls.some(row => row.classifier === 'classifyDirectSettle')).toBe(true);
    const recovery = trace.findIndex(row => row.name === 'recover');
    // These queue capabilities are explicitly required by the recovery contract.
    // Other installers may run later in boot, before HTTP readiness.
    if (name === 'installMemoryApprovalAccess' || name === 'installSynchronousQueueDeliveries') expect(trace.findIndex(row => row.name === name)).toBeLessThan(recovery);
    if (name === 'installEngineApprovalBuilder') expect(trace.findIndex(row => row.name === name)).toBeGreaterThan(trace.findIndex(row => row.name === 'installDecisionHost'));
  });
});
