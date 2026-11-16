#!/usr/bin/env python3
"""Refresh only live dispositions after inspecting every new hit. Never changes the reference inventory."""
import hashlib, json, os, pathlib, re, subprocess
root = pathlib.Path(__file__).resolve().parent.parent
base = root / 'codemap/tool-identity-sites-r12.out'
live = root / 'codemap/tool-identity-sites-current.out'
subprocess.run(['sh', str(root / 'codemap/tool-identity-sites-r12.sh'), str(live)], env={**os.environ, 'WT':str(root)}, check=True)
def disposition(tag, path, source):
    if tag == 'P10':
        if path in ['server/tts/speech-text.ts','server/loop-nudge.ts','server/approval-text.ts','server/harness/bus.ts','server/runtime-event-out.ts','shared/approval-plain.ts','shared/connected-app-calls.ts','shared/delegation-tool.ts','shared/tool-activity.ts','server/message-db.ts','server/drivers/phone-tool-schemas.ts']:
            return 'Allowlist: display, transcript extraction, schema or redaction; does not prove approval identity.'
        if path == 'server/drivers/acp/hermes.ts': return 'Allowlist: trusted hook envelope serialization/normalization; shared classifier validates the received shape.'
        if path == 'shared/tool-identity.ts': return 'S1: single identity constructor; reads engine envelopes and stamped dispatcher arguments only.'
        if path == 'server/drivers/acp/tool-tripwire.ts': return 'S1/S3: reference state machine reads engine-owned permission envelopes and frozen ask evidence.'
        if path in ['server/project-proposal-engines.ts','server/drivers/acp/fuigo-memory-permission.ts','server/reply-action-guard.ts']: return 'S5 migration: wrapper/proposal/reply policy; require proven dispatcher identity before argument names affect authority.'
        if path == 'server/index.ts': return 'Allowlist: input display truncation and reply payload forwarding; S5 migrates policy identity separately.'
        if path == 'server/browser-floor-builtin.ts': return 'Allowlist: builtin browser operation dispatch, not model argument identity.'
        if path == 'server/drivers/pi-mcp-extension.ts': return 'Allowlist: iterates the mounted tool registry; engine metadata, not model input.'
        return 'S5 migration: native engine envelope or policy routing; route identity through the shared constructor; arguments remain payload.'
    if tag in ['P1','P5','P8','P9','P12','P15']: return 'S2/S3 integration: consume shared identity and driver-held correlation state; protocol/display-only hits retain their existing role.'
    if tag in ['P6','P11']: return 'S5 policy migration: parsed identity and executable payload; unrelated call lifecycle methods retain their existing role.'
    if tag == 'P7': return 'S4 reader/finalizer migration: terminal-twin verdict parity.'
    if tag == 'P14': return 'S1 D5 default drops admin pre-tool hooks; S2/S3 own turn configuration and refusal fallback.'
    if tag == 'P13': return 'S5: canonical own-call digest consumes proven identity.'
    if tag in ['P2','P3','P4','P16']: return 'S1 ACP ask evidence; S5 migrates remaining native emitters/consumers; question-only emitters carry no permission identity.'
    raise ValueError(tag)
def rows(path):
    result=[]
    for line in path.read_text().splitlines():
        m=re.match(r'(P\d+) ([^:]+):(\d+):(.*)',line)
        if not m: continue
        tag,file,no,source=m.groups()
        result.append(dict(tag=tag,file=file,line=int(no),source=source,hash=hashlib.sha256((tag+' '+file+':'+source).encode()).hexdigest(),disposition=disposition(tag,file,source)))
    return result
baseline,current=rows(base),rows(live)
(root/'codemap/approval-identity-sites.json').write_text(json.dumps({'baseline':baseline,'current':current},indent=2,ensure_ascii=False)+'\n')
for filename, subset in [('TOOLNAME-READS.md',lambda r:r['tag']=='P10'),('APPROVAL-IDENTITY-SITES.md',lambda r:True)]:
    body=['# r1.2 approval identity inventory','', 'Each row is one hit from all 16 normative patterns. Baseline rows are immutable evidence; current rows are the checked disposition registry. S2/S3/S4/S5 entries name the integration owner, not completed migrations.','']
    for title,rs in [('Reference at 5cf79747a',baseline),('Current worktree',current)]:
        body+=['## '+title,'','| Pattern | Site | Source | Disposition |','|---|---|---|---|']
        for row in filter(subset,rs):
            src=row['source'].replace('|','&#124;').replace('`','&#96;')
            body.append(f"| {row['tag']} | {row['file']}:{row['line']} | <code>{src}</code> | {row['disposition']} |")
        body.append('')
    (root/'codemap'/filename).write_text('\n'.join(body))
print('baseline hits',len(baseline),'current hits',len(current),'P10',sum(r['tag']=='P10' for r in baseline))
