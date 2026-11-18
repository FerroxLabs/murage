#!/usr/bin/env python3
"""BLOCK regression mutants, assertion failures only; disposable container required."""
from pathlib import Path
import json, os, subprocess
if not Path('/.dockerenv').exists():
    raise SystemExit('container required')
selected = set(filter(None, os.environ.get('AFIX_MUTANTS', '').split(',')))
out = Path('.afix-evidence') / ('mutants-' + '-'.join(sorted(selected)) if selected else 'mutants')
out.mkdir(parents=True, exist_ok=True)
mutants = [
 ('BLOCK1', 'server/drivers/request-delivery.ts', 'server/drivers/native-answer-ack.test.ts', 'BLOCK1',
  'const accepted = receipt ? await receipt.done : false;', 'const accepted = true;'),
 ('BLOCK2', 'server/drivers/acp/core.ts', 'server/drivers/acp-posture-switch.test.ts', 'BLOCK2',
  'const immutablePosture = Boolean(support.askStop?.apply && !support.askStop?.sessionMode);', 'const immutablePosture = false;'),
 ('BLOCK4', 'scripts/no-limits-live/counts.mjs', 'scripts/no-limits-live/review-blocks.test.mjs', 'BLOCK4',
  "let cards = allCards.filter(c => !c.question && c.why !== 'question');", 'let cards = allCards;'),
 ('BLOCK5', 'server/drivers/answer-delivery.ts', 'server/drivers/answer-idempotency.test.ts', 'BLOCK5',
  'if (this.terminal.size > 1024)', 'if (this.terminal.size > Number.MAX_SAFE_INTEGER)'),
 ('BLOCK6', 'scripts/nolim-replay/replay-decide.mjs', 'scripts/no-limits-live/review-blocks.test.mjs', 'BLOCK6',
  '|| texts.some(s => cut.test(s)) || texts.some(s => masked.test(s))', '|| false || texts.some(s => masked.test(s))'),
 ('BLOCK7', 'scripts/no-limits-live/observe.mjs', 'scripts/no-limits-live/review-blocks.test.mjs', 'BLOCK7',
  ' return false;\n}', " return report?.network === 'allowlist';\n}"),
 ('BLOCK8', 'scripts/no-limits-live/counts.mjs', 'scripts/no-limits-live/start-accounting.test.mjs', 'BLOCK8',
  "if (release && (!checkContainment(report.containment) || report.baselineComparison?.verdict !== 'PASS' || report.rows.some(r => r.accounting?.verdict !== 'PASS'))) return 'FAIL';", ''),
 ('BLOCK9-codex', 'server/drivers/codex.ts', 'server/drivers/codex-posture-switch.test.ts', 'BASE 292df98d',
  'threadId: codexThreadId,\n          // `{type:"image"', 'threadId: codexThreadId, effort: "low",\n          // `{type:"image"'),
 ('BLOCK9-claude', 'server/drivers/claude.ts', 'server/drivers/claude-posture-switch.test.ts', 'BASE 292df98d',
  'args.push("--append-system-prompt-file", systemPromptPath);', 'args.push("--verbose"); args.push("--append-system-prompt-file", systemPromptPath);'),
]
results=[]
for name, file, test, match, before, after in mutants:
    if selected and name not in selected: continue
    target=Path(file); original=target.read_text()
    if original.count(before) != 1: raise RuntimeError(f'{name}: ambiguous/missing anchor')
    command=['node','node_modules/vitest/vitest.mjs','run',test,'-t',match,'--maxWorkers=1']
    try:
        target.write_text(original.replace(before,after,1))
        run=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
        log=run.stdout.decode(errors='replace'); path=out/(name+'.log'); path.write_text(log)
        killed=run.returncode==1 and ('AssertionError' in log or 'Test timed out in' in log) and 'Failed Suites' not in log
        results.append(dict(mutant=name,command=command,exit=run.returncode,killed=killed,log=str(path)))
        print(name,'KILLED' if killed else 'NOT KILLED',flush=True)
    finally: target.write_text(original)
(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
raise SystemExit(0 if results and all(r['killed'] for r in results) else 1)
