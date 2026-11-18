#!/usr/bin/env python3
"""Test-only, content-free observation overlay for an already extracted pin.
Does not change a verdict, response, trigger, or durable write. Refuses anchor
mismatches. Source and overlay hashes remain distinct in the receipt.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import subprocess
import re

root=Path(__file__).resolve().parents[2]
dest=Path(sys.argv[1]).resolve()
if not any(dest.is_relative_to(root/path) for path in ('.nolim-evidence/bld3/pins','.nolim-evidence/bld4/api-pins')): raise SystemExit('ALLOCATION')
index=dest/'server/index.ts'
s=index.read_text()
source_sha=sys.argv[2]
if not re.fullmatch('[a-f0-9]{40}',source_sha): raise SystemExit('SOURCE-SHA')
pinned=subprocess.check_output(['git','-C',str(root),'show',source_sha+':server/index.ts']).decode()
unobserved=''.join(line for line in s.splitlines(keepends=True) if 'observeApproval' not in line and not line.startswith('import { observeJudgeInput }'))
unobserved=unobserved.replace('routineTurnApproval(observeJudgeInput(event.threadId, event.requestId, {','routineTurnApproval({').replace('          })).verdict\n        : null);','          }).verdict\n        : null);')
if unobserved!=pinned: raise SystemExit('PIN-INDEX-MISMATCH')
before=hashlib.sha256(pinned.encode()).hexdigest()
# These are the same observational calls as the builder's existing index seam.
anchors=[
 ('import { validateBotCwd }', 'import { observeApproval } from "./approval-observation.ts";\n'),
 ('      const askReceivedAt = performance.now();', '      observeApproval({ kind: "request", thread: event.threadId, request: event.requestId });\n'),
 ('      // Rule 72 (APP-GRANT-DESIGN-FINAL.AGREED-r10.md): a narrowing denial', '      if (verdict) observeApproval({ kind: "verdict", thread: event.threadId, request: event.requestId, source: verdict.source });\n'),
 ('            const outcome = await instance?.adapter.respondToRequest(event.threadId, requestId, { behavior: "deny", message: reason, source: "narrow" });', '            observeApproval({ kind: "answer-attempt", thread: event.threadId, request: requestId, behavior: "deny" });\n'),
 ('            if (!outcome || outcome === "unavailable") return;', '            if (outcome !== "unavailable" && outcome !== undefined) observeApproval({ kind: "answer", thread: event.threadId, request: requestId, behavior: "deny" });\n'),
 ('            const outcome = await instance.adapter.respondToRequest(event.threadId, requestId, { behavior: "allow" });', '            observeApproval({ kind: "answer-attempt", thread: event.threadId, request: requestId, behavior: "allow" });\n'),
 ('            stopHitByRequest.delete(`${event.threadId}:${requestId}`);', '            observeApproval({ kind: "answer", thread: event.threadId, request: requestId, behavior: "allow" });\n'),
 ('      // Who answered, at info level:', '      observeApproval({ kind: "ack", thread: event.threadId, request: event.requestId, behavior: event.behavior === "allow" ? "allow" : "deny" });\n'),
 ('      // The run this terminal event may settle', '      observeApproval({ kind: "terminal", thread: event.threadId, terminal: event.ok ? "completed" : "failed" });\n'),
]
if 'import { observeApproval }' not in s:
 for anchor,addition in anchors:
  if s.count(anchor)!=1: raise SystemExit('ANCHOR-COUNT')
  s=s.replace(anchor,addition+anchor)
 notify='function notifyApproval(botId: string, threadId: string, requestId: string, messageId: string, requestTurnId?: string) {'
 if s.count(notify)!=1: raise SystemExit('NOTIFY-ANCHOR')
 s=s.replace(notify,notify+'\n  observeApproval({ kind: "notify", thread: threadId, request: requestId, message: messageId });')
 index.write_text(s)
if 'import { observeJudgeInput }' not in s:
 begin='routineTurnApproval({'
 end='          }).verdict\n        : null);'
 if s.count(begin)!=1 or s.count(end)!=1: raise SystemExit('JUDGE-ANCHOR')
 s='import { observeJudgeInput } from "./testing/nolim-replay/judge-tap.ts";\n'+s.replace(begin,'routineTurnApproval(observeJudgeInput(event.threadId, event.requestId, {').replace(end,'          })).verdict\n        : null);')
 index.write_text(s)
files=[root/'server/approval-observation.ts',root/'server/no-limits-replay-bld3-api.test.ts']
files+=[p for p in (root/'server/testing/nolim-replay').rglob('*') if p.is_file()]
files+=[root/'server/testing'/name for name in ['fake-acp-cli.ts','fake-claude-cli.ts','fake-codex-app-server.ts','fake-pi-cli.ts','fake-muse-cli.ts','fake-agy-cli.ts']]
for path in files:
 target=dest/path.relative_to(root); target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,target)
nm=dest/'node_modules'
if not nm.exists() and not nm.is_symlink(): nm.symlink_to('../../../../node_modules',target_is_directory=True)
receipt={'kind':'synthetic','sourceSha':source_sha,'indexBefore':before,'indexInstrumented':hashlib.sha256(s.encode()).hexdigest(), 'overlayFiles':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},'releaseEligible':False}
(dest/'synthetic-overlay.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'instrumented':1,'overlayFiles':len(files)}))
