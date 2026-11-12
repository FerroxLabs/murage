#!/usr/bin/env python3
import json, pathlib, sys
root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'server/testing/fixtures/no-limits-r12'))
import judge
records=[]
for row in json.loads((root/'server/testing/fixtures/no-limits-r13.json').read_text()):
    recipe=row.get('repeat')
    value=row.get('payload')
    if recipe:
        value=recipe.get('prefix','')+recipe['text']*recipe['count']+recipe.get('suffix','')
        if 'field' in recipe:value={recipe['field']:value}
    original=judge.read_sh
    if row.get('fault'):
        def failed(*args,**kwargs):raise judge.ReaderCut('reviewer fault injection')
        judge.read_sh=failed
    try:
        # Environment/truncation failures are policy metadata, not payload syntax.
        mode='nl-cut' if row.get('context') else 'nl'
        result=judge.judge(row['identity'],value,mode)
        got=result.verdict+(':'+result.cls if result.cls else '')
        records.append({'id':row['id'],'expected':row['expected'],'oracleExpected':row.get('oracleExpected',row['expected']),'actual':got,'match':got==row.get('oracleExpected',row['expected'])})
    finally:judge.read_sh=original
(root/'evidence/bld3-toolid-s4a/review-oracle.json').write_text(json.dumps(records,indent=2)+'\n')
print(json.dumps({'rows':len(records),'matches':sum(r['match'] for r in records)}))
assert all(r['match'] for r in records)
