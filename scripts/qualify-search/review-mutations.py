#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run inside the isolated test container on a disposable archive, never live data.
The host prepares /prior as the lane's pre-fix HEAD with review tests overlaid.
Each mutant is restored before the next, even when a check fails.
"""
import json, os, pathlib, subprocess, sys
root=pathlib.Path.cwd()
out=pathlib.Path(os.environ.get('MURAGE_QUAL_EVIDENCE','/qual-evidence'))
out.mkdir(parents=True,exist_ok=True)
vt=['node','node_modules/vitest/vitest.mjs','run','--config','scripts/qualify-search/vitest.config.ts','--tags-filter=qual','--reporter=json']
env={**os.environ,'MURAGE_QUAL':'review','MURAGE_QUAL_SMOKE':'1','MURAGE_QUAL_FAIL_BAR':'integrity','MURAGE_QUAL_STORAGE':'/data'}
results=[]
def run(label, block, cwd=root):
    report=out/(label+'.json')
    with (out/(label+'.log')).open('w') as log:
        child=subprocess.run(vt+['-t','BLOCK-'+str(block)+' ', '--outputFile='+str(report)],cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT)
    data=json.loads(report.read_text())
    tests=[a for suite in data['testResults'] for a in suite['assertionResults'] if a['status'] not in ('pending','skipped','todo')]
    assert len(tests)==1,(label,tests)
    test=tests[0];assert len(test.get('failureMessages',[]))==1,label;message=(test.get('failureMessages')or[''])[0]
    assert child.returncode and test['status']=='failed' and message.startswith('AssertionError') and 'ORACLE:BLOCK-'+str(block) in message,(label,message)
    assert not any(suite.get('message') for suite in data['testResults']),label
    results.append({'case':label,'block':block,'result':'RED-BEHAVIOUR','assertion':message.splitlines()[0]})
    print(label,results[-1]['assertion'],flush=True)

if sys.argv[1]=='red':
    for block in range(1,8):run('red-'+str(block),block)
else:
    # Reintroduce exactly the behavior guarded by each review regression.
    mutants=[
      (1,'support.ts',"this.pass[id] = value;", "this.pass[id] = failBar === id ? false : value;"),
      (2,'copy-tools.ts',"candidates.add(Number(row.rowid));", "{ if (candidates.size < 2000) candidates.add(Number(row.rowid)); }"),
      (3,'support.ts',"hash() { const hash =", "hash() { return hashRows(db); const hash ="),
      (4,'support.ts',"if (existsSync(file)) unlinkSync(file);", "if (false && existsSync(file)) unlinkSync(file);"),
      (5,'rig.mjs',"'merged-cases':!merged||Object.values(mergedCases).every(Boolean)", "'merged-cases':true"),
      (5,'rig.mjs',"return source.replaceAll(anchor,", "return source; return source.replaceAll(anchor,"),
      (5,'rig.mjs',"return ['--force','--out',out];", "return [];"),
      (6,'check-reset-set.mjs',"/C15': SIGKILL reset-before-delete/,/C15': SIGKILL reset-after-wal-delete/,", ""),
      (7,'english-inventory.mjs',"entries.push({file,line,literal,", "if(literal !== 'copy gate refuses symbolic links') entries.push({file,line,literal,"),
    ]
    for number,(block,file,before,after) in enumerate(mutants,1):
        path=root/'scripts/qualify-search'/file
        source=path.read_text();assert source.count(before)==1,(file,before)
        try:
            path.write_text(source.replace(before,after))
            run('mutant-'+str(number)+'-block-'+str(block),block)
        finally:path.write_text(source)
(out/(sys.argv[1]+'-summary.json')).write_text(json.dumps(results,indent=2)+'\n')
