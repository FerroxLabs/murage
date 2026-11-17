#!/usr/bin/env python3
"""Compare identical assertion bytes by stable ID; retain failures and setup blocks."""
import collections,hashlib,json,re,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'evidence/afix-gnl-prod-r5'
def read(p):return json.loads(p.read_text())
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def collect(paths):
    rows={};suites=[];hashes={};runtime=[]
    for p in paths:
        manifest=read(p.parent/'manifest.json');runtime.append(manifest)
        for suite in read(p)['testResults']:
            candidates=[f for f in manifest['tests'] if suite['name'].endswith('/'+f)]
            if len(candidates)!=1:raise ValueError('Unknown suite '+suite['name'])
            file=candidates[0];hashes[file]=manifest['testHashes'][file]
            # A supplemental report replaces this whole file, including setup errors.
            rows={k:v for k,v in rows.items() if not k.startswith(file+' > ')}
            suites=[s for s in suites if s['file']!=file]
            suites.append({'file':file,'status':suite['status'],'message':suite.get('message','')})
            seen=collections.Counter()
            for a in suite['assertionResults']:
                raw=' > '.join(a.get('ancestorTitles',[])+[a['title']]);title=raw
                if file=='server/no-limits-symlink-r31.test.ts':title=re.sub(r'(?<=C3 recursive deletion through a link to )/tmp/murage-test-home-[A-Za-z0-9]+(?=, ordinary=)','$FIXTURE_HOME',title)
                seen[title]+=1;key=f'{file} > {title} #{seen[title]}'
                if key in rows:raise ValueError('Duplicate ID '+key)
                rows[key]={'status':a['status'],'failures':a.get('failureMessages',[]),**({'rawTitle':raw} if raw!=title else {})}
    return rows,suites,hashes,runtime

def compare(before,after):
    rows=[]
    for key in sorted(set(before)|set(after)):
        b=before.get(key);h=after.get(key)
        cls='MISSING' if h is None else ('NEW' if h['status']=='failed' else 'ADDED') if b is None else 'PREEXISTING' if b['status']=='failed' and h['status']=='failed' else 'NEW' if h['status']=='failed' else 'FIXED' if b['status']=='failed' else 'UNCHANGED'
        rows.append({'id':key,'classification':cls,'base':b,'head':h})
    return rows

def summary(before,after,rows):
    return {'base':dict(collections.Counter(r['status'] for r in before.values())),'head':dict(collections.Counter(r['status'] for r in after.values())),'classifications':dict(collections.Counter(r['classification'] for r in rows)),'newBlocked':[r['id'] for r in rows if r['base'] and r['base']['status']=='passed' and r['head'] and r['head']['status'] in ['skipped','pending','todo']]}

def main():
    spec=read(OUT/'comparison-plan.json')
    b,bs,bh,bm=collect([ROOT/p for p in spec['baseReports']]);h,hs,hh,hm=collect([ROOT/p for p in spec['headReports']])
    if bh!=hh:raise ValueError('Assertion hash differences: '+str([f for f in set(bh)|set(hh) if bh.get(f)!=hh.get(f)]))
    if set(hh)!=set(read(OUT/'tests-final.json')):raise ValueError('Missing planned test files')
    for f,sha in hh.items():
        if digest(ROOT/f)!=sha:raise ValueError('Assertion file moved: '+f)
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    base=read(OUT/'base-runtime.json')['sha']
    source_checks=[]
    for manifest in hm:
        for f,sha in manifest['runtimeHashes'].items():
            if digest(ROOT/f)!=sha:raise ValueError('Head runtime moved: '+f)
            blob=subprocess.check_output(['git','show',head+':'+f],cwd=ROOT)
            if hashlib.sha256(blob).hexdigest()!=sha:raise ValueError('Head Git mismatch: '+f)
    for manifest in bm:
        for f,sha in manifest['runtimeHashes'].items():
            blob=subprocess.check_output(['git','show',base+':'+f],cwd=ROOT)
            if hashlib.sha256(blob).hexdigest()!=sha:raise ValueError('Base Git mismatch: '+f)
    rows=compare(b,h);s=summary(b,h,rows)
    old=read(ROOT/'evidence/gnl-prod-r5/decision-by-id.json')
    historical={r['id']:r['baseline'] for r in old['rows'] if r['baseline']}
    relevant={k:v for k,v in h.items() if k in historical}
    historical_rows=compare(historical,relevant);historic=summary(historical,relevant,historical_rows)
    discovered=read(ROOT/'evidence/gnl-prod-r5/resolved-new-ids.json')
    resolved=[{'id':r['id'],'resolution':r['resolution'],'head':h.get(r['id'])} for r in discovered]
    if any(not r['head'] or r['head']['status']!='passed' for r in resolved):raise ValueError('Original discovered NEW ID is not passing')
    result={'baseSha':base,'headSha':head,'historicalBaseSha':'4e7310cf1bb595800c8d1eb602978bd275c9a2f4','files':len(hh),'sameAssertionHashes':True,'summary':s,'historicalSummary':historic,'rows':rows,'historicalRows':historical_rows,'resolved430':resolved,'baseSuites':bs,'headSuites':hs,'plan':spec}
    (OUT/'decision-comparison.json').write_text(json.dumps(result,indent=2)+'\n')
    if s['classifications'].get('NEW',0) or s['classifications'].get('MISSING',0) or s['newBlocked']:raise ValueError('Afix zero-new gate failed')
    if historic['classifications'].get('NEW',0) or historic['classifications'].get('MISSING',0) or historic['newBlocked']:raise ValueError('Historical zero-new gate failed')
    print(json.dumps({k:result[k] for k in ['baseSha','headSha','files','summary','historicalSummary']}))
if __name__=='__main__':main()
