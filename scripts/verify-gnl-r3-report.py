#!/usr/bin/env python3
"""Aggregate retained test/cell evidence, never alter an assertion or verdict."""
import collections, glob, hashlib, json, os, re
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'evidence/gnl-prod-r3'
def read(path):return json.loads(Path(path).read_text())
def save(name,obj):(OUT/name).write_text(json.dumps(obj,indent=2)+'\n')
def load_pair(name):
    paths=sorted((OUT/name).glob('shard-*/results.json'))
    if len(paths)!=2:return None
    manifests=[read(p.parent/'manifest.json') for p in paths]
    tests={}; suites=[]; errors=[]
    for p in paths:
        j=read(p)
        for suite in j['testResults']:
            file='server/'+suite['name'].split('/server/',1)[-1]
            suites.append({'file':file,'status':suite['status'],'message':suite.get('message',''),'assertions':len(suite['assertionResults'])})
            occurrences=collections.Counter()
            for a in suite['assertionResults']:
                title=' > '.join(a.get('ancestorTitles',[])+[a['title']]);occurrences[title]+=1
                key=f"{file} > {title} #{occurrences[title]}"
                if key in tests:raise ValueError('duplicate test '+key)
                tests[key]={'file':file,'title':title,'fullName':a['fullName'],'status':a['status'],'failures':a.get('failureMessages',[])}
    return {'tests':tests,'suites':suites,'manifests':manifests}
baseline=load_pair('decision-baseline-pair');final=load_pair('decision-final-pair')
if baseline and final:
    b,f=baseline['tests'],final['tests'];rows=[]
    for key in sorted(set(b)|set(f)):
        before=b.get(key);after=f.get(key)
        status='MISSING' if not before or not after else 'PREEXISTING' if before['status']=='failed' and after['status']=='failed' else 'NEW' if after['status']=='failed' else 'FIXED' if before['status']=='failed' else 'UNCHANGED'
        rows.append({'id':key,'classification':status,'baseline':before and before['status'],'final':after and after['status'],'baselineFailures':before and before['failures'],'finalFailures':after and after['failures']})
    bh=baseline['manifests'][0]['testHashes'];fh=final['manifests'][0]['testHashes']
    hashes={file:{'baseline':bh.get(file),'final':fh.get(file)} for file in set(bh)|set(fh) if bh.get(file)!=fh.get(file)}
    old=read(ROOT/'evidence/gnl-prod/decision-baseline-comparison.json')
    raw=(ROOT/'evidence/gnl-prod/decision-candidate.log').read_text()
    labels=set(re.findall(r'^ FAIL  (server/[^\n]+)',raw,re.M));old_ids=[];unmatched=[];hook_labels=[]
    for label in sorted(labels):
        if ' > ' not in label:continue
        matches=[key for key in set(b)|set(f) if key.rsplit(' #',1)[0]==label]
        if not matches:
            descendants=[key for key in set(b)|set(f) if key.startswith(label+' > ')]
            if descendants:hook_labels.append({'label':label,'blockedTestIds':sorted(descendants)})
            else:unmatched.append(label)
        for key in matches:
            row=next(r for r in rows if r['id']==key)
            old_ids.append({'historicalLabel':label,**row})
    save('decision-by-id.json',{'baseline':{'tests':len(b),'counts':dict(collections.Counter(r['status'] for r in b.values()))},'final':{'tests':len(f),'counts':dict(collections.Counter(r['status'] for r in f.values()))},'classification':dict(collections.Counter(r['classification'] for r in rows)),'testHashDifferences':hashes,'rows':rows,'baselineSuites':baseline['suites'],'finalSuites':final['suites']})
    save('historical-471-by-id.json',{'historicalFailedAssertions':471,'historicalFailedSnapshots':424,'mappedTestIds':len(old_ids),'unmatchedHistoricalLabels':unmatched,'rows':old_ids,'hookFailures':hook_labels,'suiteErrors':[label for label in sorted(labels) if ' > ' not in label]})
plan=read(OUT/'all-cells-latest.json');expected={(r['engine'],r['id']) for rs in plan.values() for r in rs};actual={};duplicates=[];source=[]
paths=list(OUT.glob('all-cells/shard-*/*/verdict.json'))+list(OUT.glob('supplemental-cells/shard-*/*/verdict.json'))+list(OUT.glob('p4-final/verdict.json'))
for p in paths:
    for row in read(p).get('rows',[]):
        key=(row['engine'],row['id'])
        if key in actual:duplicates.append({'engine':key[0],'id':key[1]})
        actual[key]=row
for p in OUT.glob('all-cells/shard-*/source.json'):source.append(read(p))
source_diffs=[]
if len(source)==2:
    for file in set(source[0]['files'])|set(source[1]['files']):
        if source[0]['files'].get(file)!=source[1]['files'].get(file):source_diffs.append(file)
original=read(ROOT/'evidence/gnl-prod/affected-cells.json');families={}
for family,rs in original.items():
    keys={(r['engine'],r['id']) for r in rs};found=[actual[k] for k in keys if k in actual]
    families[family]={'expected':len(keys),'pass':sum(r['verdict']=='PASS' for r in found),'fail':sum(r['verdict']!='PASS' for r in found),'missing':[{'engine':e,'id':i} for e,i in sorted(keys-set(actual))]}
save('cells-summary.json',{'planned':len(expected),'observed':len(actual),'pass':sum(r['verdict']=='PASS' for r in actual.values()),'fail':sum(r['verdict']!='PASS' for r in actual.values()),'missing':[{'engine':e,'id':i} for e,i in sorted(expected-set(actual))],'duplicateReruns':duplicates,'sourceHashDifferences':source_diffs,'originalFamilies':families,'failures':[r for r in actual.values() if r['verdict']!='PASS']})
print(json.dumps({'decisionComplete':bool(baseline and final),'plannedCells':len(expected),'observedCells':len(actual),'families':families}))
