#!/usr/bin/env python3
"""Offline assertion mutants. Runs serially in one --network none container."""
import json
from pathlib import Path
import subprocess
import os

root = Path.cwd()
if not Path('/.dockerenv').exists():
    raise SystemExit('container required')
selected = set(filter(None, os.environ.get('S3_MUTANTS', '').split(',')))
out = root / '.s3-evidence' / ('mutants-r31-' + '-'.join(sorted(selected)) if selected else 'mutants-r31')
out.mkdir(parents=True, exist_ok=True)

def swap(old, new):
    def mutate(source):
        if old not in source:
            raise RuntimeError('mutant anchor missing')
        return source.replace(old, new, 1)
    return mutate

mutants = [
 ('M31', 'server/drivers/acp/core.ts', 'server/drivers/acp-posture-switch.test.ts', swap('await active.get(threadId)?.onPostureChange?.();', 'void threadId;')),
 ('M32', 'server/drivers/answer-delivery.ts', 'server/drivers/answer-idempotency.test.ts', swap("if (entry.answerId !== answerId || entry.hash !== hash)", 'if (false)')),
 ('M34', 'scripts/no-limits-live/counts.mjs', 'scripts/no-limits-live/release.test.mjs', swap("if (!observation.actionProven)", 'if (false)')),
 ('M35', 'scripts/no-limits-live/observe.mjs', 'scripts/no-limits-live/oracle.test.mjs', swap("['queue',queues]", "['queue',[]]")),
 ('M62', 'server/drivers/answer-delivery.ts', 'server/drivers/answer-idempotency.test.ts', swap("if (entry.state === 'pending') return entry.done;", "if (entry.state === 'pending') return Promise.resolve({ state: 'accepted' });")),
 ('M63', 'server/drivers/codex.ts', 'server/drivers/codex-posture-switch.test.ts', swap('respondToRequest: async (threadId, requestId, decision) => {', 'respondToRequest: async (threadId, requestId, decision) => { await active.get(threadId)?.onPostureChange?.();')),
 ('M66', 'scripts/no-limits-live/oracle-class.mjs', 'scripts/no-limits-live/oracle.test.mjs', swap('(r.inputHash ?? hashInput(r.input)) === actual.inputHash', 'true')),
 ('M67', 'scripts/no-limits-live/observe.mjs', 'scripts/no-limits-live/oracle.test.mjs', swap("credentials++; if (message.card", "credentials++; if (!ids.has(message.card?.approvalId)) fail('credential without record'); if (message.card")),
 ('M70', 'server/drivers/muse-code.ts', 'server/drivers/muse-code-posture-switch.test.ts', swap('await threads.get(threadId)?.active?.onPostureChange?.();', 'void threadId;')),
 ('M71', 'server/drivers/claude.ts', 'server/drivers/claude-posture-switch.test.ts', swap('const permissionMode = config.permissionMode ===', 'const permissionMode = (turn.permissionNow?.() ?? turn).askLevel ? "default" : config.permissionMode ===')),
 ('M72', 'server/drivers/codex.ts', 'server/drivers/codex-posture-switch.test.ts', swap('gatePlan.mode === "gated" || approvalNow() ? { approvalPolicy: policy().approvalPolicy } : {}', '{ approvalPolicy: policy().approvalPolicy }')),
 ('M73', 'scripts/no-limits-live/observe.mjs', 'scripts/no-limits-live/oracle.test.mjs', swap(" return false;\n}", " return report?.container === true && report.network === 'allowlist';\n}")),
 ('agy-captured', 'server/drivers/antigravity.ts', 'server/drivers/antigravity-posture-switch.test.ts', swap('const askStop = () => askFromFolderHooks || ((turn.permissionNow?.() ?? turn).askLevel === true && !skipPermissions);', 'const capturedAsk = (turn.permissionNow?.() ?? turn).askLevel === true; const askStop = () => askFromFolderHooks || (capturedAsk && !skipPermissions);')),
 ('muse-captured', 'server/drivers/muse-code.ts', 'server/drivers/muse-code-posture-switch.test.ts', swap('if ((turn.permissionNow?.() ?? turn).stopLine) return "full";', 'if (turn.stopLine) return "full";')),
 ('release-skip', 'scripts/no-limits-live/counts.mjs', 'scripts/no-limits-live/release.test.mjs', swap('if (release && (report.engines.length', 'if (false && (report.engines.length')),
 ('duplicate-card', 'scripts/no-limits-live/counts.mjs', 'scripts/no-limits-live/release.test.mjs', swap('cards.length !== 1', '!cards.length')),
 ('routine-parity', 'scripts/nolim-replay/replay-decide.mjs', 'scripts/nolim-replay/replay-contract.test.mjs', swap("replayActor(row).kind === 'other'", "replayActor(row).kind !== 'owner'")),
]
results = []
for name, path, test, mutate in mutants:
    if selected and name not in selected:
        continue
    target = root / path
    original = target.read_text()
    command = ['node', 'node_modules/vitest/vitest.mjs', 'run', test, '--maxWorkers=1']
    try:
        target.write_text(mutate(original))
        run = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        log = run.stdout.decode(errors='replace')
        (out / (name + '.log')).write_text(log)
        killed = run.returncode == 1 and ('AssertionError' in log or 'Test timed out in' in log) and 'Failed Suites' not in log
        results.append({'mutant': name, 'command': command, 'log': str(out / (name + '.log')), 'exit': run.returncode, 'killed': killed})
        print(name, 'KILLED' if killed else 'NOT KILLED', flush=True)
    finally:
        target.write_text(original)
(out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
raise SystemExit(0 if results and all(r['killed'] for r in results) else 1)
