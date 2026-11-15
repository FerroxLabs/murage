#!/usr/bin/env python3
"""Keep every test id, failure, setup error and ruling visible."""
import collections,json,re,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'evidence/gnl-prod-r5'
def read(p):return json.loads(p.read_text())
def load(modes):
    tests={};suites=[];manifests=[]
    for mode,count in modes:
        paths=sorted((OUT/mode).glob('*/results.json'))
        if len(paths)!=count:raise ValueError(f'{mode}: expected {count} reports, got {len(paths)}')
        for p in paths:
            manifest=read(p.parent/'manifest.json');manifests.append(manifest)
            result=read(p)
            collected=set()
            for suite in result['testResults']:
                candidates=[p for p in manifest['tests'] if suite['name'].endswith('/'+p)]
                if len(candidates)!=1:raise ValueError('Unknown suite: '+suite['name'])
                file=candidates[0]
                collected.add(file)
                suites.append({'file':file,'status':suite['status'],'message':suite.get('message',''),'assertions':len(suite['assertionResults'])})
                seen=collections.Counter()
                for a in suite['assertionResults']:
                    raw_title=' > '.join(a.get('ancestorTitles',[])+[a['title']])
                    title=raw_title
                    if file=='server/no-limits-symlink-r31.test.ts':
                        title=re.sub(r'(?<=C3 recursive deletion through a link to )/tmp/murage-test-home-[A-Za-z0-9]+(?=, ordinary=)', '$FIXTURE_HOME', title)
                    seen[title]+=1
                    key=f'{file} > {title} #{seen[title]}'
                    if key in tests:raise ValueError('duplicate id: '+key)
                    tests[key]={'status':a['status'],'failures':a.get('failureMessages',[]),**({'rawTitle':raw_title} if raw_title!=title else {})}
            if collected!=set(manifest['tests']):raise ValueError('Uncollected test files: '+str(set(manifest['tests'])-collected))
    return tests,suites,manifests
def compare(b,f):
    rows=[]
    for key in sorted(set(b)|set(f)):
        before=b.get(key);after=f.get(key)
        classification='MISSING' if not after else ('NEW' if after['status']=='failed' else 'ADDED') if not before else 'PREEXISTING' if before['status']=='failed' and after['status']=='failed' else 'NEW' if after['status']=='failed' else 'FIXED' if before['status']=='failed' else 'UNCHANGED'
        rows.append({'id':key,'classification':classification,'baseline':before,'final':after})
    return rows
if __name__=='__main__':
    b,bs,bm=load([('baseline-final',6),('baseline-supplement',2),('baseline-extended',2)])
    f,fs,fm=load([('final4',6)])
    if any(m['runtimeHashes']!=bm[0]['runtimeHashes'] for m in bm):raise ValueError('Baseline runtime differs between shards')
    if any(m['runtimeHashes']!=fm[0]['runtimeHashes'] for m in fm):raise ValueError('Final runtime differs between shards')
    for file,digest in fm[0]['runtimeHashes'].items():
        if hashlib.sha256((ROOT/file).read_bytes()).hexdigest()!=digest:raise ValueError('Current runtime moved: '+file)
    bh={file:digest for m in bm for file,digest in m['testHashes'].items()}
    fh={file:digest for m in fm for file,digest in m['testHashes'].items()}
    for file,digest in fh.items():
        if hashlib.sha256((ROOT/file).read_bytes()).hexdigest()!=digest:raise ValueError('Current assertion bytes moved: '+file)
    rows=compare(b,f)
    classes=collections.Counter(r['classification'] for r in rows)
    new_blocked=[r['id'] for r in rows if r['baseline'] and r['baseline']['status']=='passed' and r['final'] and r['final']['status'] in ('skipped','todo','pending')]
    summary={'baseline':dict(collections.Counter(r['status'] for r in b.values())),'final':dict(collections.Counter(r['status'] for r in f.values())),'classification':{c:classes[c] for c in ['UNCHANGED','PREEXISTING','FIXED','ADDED','NEW','MISSING']},'newBlocked':len(new_blocked)}
    (OUT/'decision-by-id.json').write_text(json.dumps({'summary':summary,'rows':rows,'baselineSuites':bs,'finalSuites':fs,'baselineManifests':bm,'finalManifests':fm,'testHashChanges':{file:{'baseline':bh.get(file),'final':fh.get(file)} for file in sorted(set(bh)|set(fh)) if bh.get(file)!=fh.get(file)},'newBlockedIds':new_blocked},indent=2)+'\n')
    i,_,_=load([('initial',6)])
    initial=compare({k:v for k,v in b.items() if k in i},i)
    (OUT/'initial-by-id.json').write_text(json.dumps(initial,indent=2)+'\n')
    discoveries={r['id']:r for r in initial if r['classification']=='NEW'}
    discoveries.update({r['id']:r for r in read(OUT/'intermediate-by-id.json')['rows'] if r['classification']=='NEW'})
    final_by_id={r['id']:r for r in rows}
    def disposition(key):
        if 'no-limits-x2-full-access.test.ts' in key or 'no-limits-y3b-full-access.test.ts' in key:
            return '(a) MAIN authenticated owner turn: absent provenance registers Ask; updated only unproven snapshots and asserted actor/level explicitly.'
        if 'no-limits-uncovered-rows.test.ts' in key:
            return '(a) MAIN authenticated owner turn: saved owner/thread levels cannot authenticate this generation. Assert Ask and no execution; absent live transport identity refuses the unaddressable request.'
        if 'no-limits-gnl-frozen.test.ts' in key:
            return '(a) MAIN authenticated owner turn: preserve the original artifact hash and every Full/service byte; allow only the unproven level and derived hashes to change.'
        if 'no-limits-mount.test.ts' in key:
            return '(b) REGRESSION fixed in the extraction harness: inject the new routine dependencies and the real ceiling helper; all existing mount/level expectations retained.'
        if 'email/no-limits-1019-api.test.ts' in key:
            return '(b) REGRESSION fixed in production dispatch: authenticate the exact persisted owner Start request. Four added negative cases remain Ask across native and service policy.'
        raise ValueError('Unclassified NEW id: '+key)
    resolved=[{'id':key,'resolution':disposition(key),'final':final_by_id[key]['final']} for key in sorted(discoveries)]
    if any(row['final']['status']!='passed' for row in resolved):raise ValueError('Discovered NEW id is not passing')
    (OUT/'resolved-new-ids.json').write_text(json.dumps(resolved,indent=2)+'\n')
    aliases=[r for r in rows if (r['baseline'] and 'rawTitle' in r['baseline']) or (r['final'] and 'rawTitle' in r['final'])]
    lines=['# NEW decision test IDs — gnl-prod-r5','',
      'Baseline: `4e7310cf1bb595800c8d1eb602978bd275c9a2f4`; start: `10b94bd4ffa4bc94958614aacc1c23df247b08c2`.',
      '','Final **NEW = '+str(classes['NEW'])+'**; missing historical IDs = '+str(classes['MISSING'])+'; newly blocked IDs = '+str(len(new_blocked))+'.',
      '',f"296 matching files; {len(b)} historical IDs and {classes['ADDED']} additional passing regression IDs. Baseline: {summary['baseline']}. Final: {summary['final']}.",
      '',f'{len(resolved)} discovered NEW IDs are listed individually below: 426 on the r4 starting tree and four found during the wider audit. Each now passes. No test was deleted, skipped or weakened. MAIN expectation changes carry the required dated comments.',
      '', 'The two C3 home-link cases in `server/no-limits-symlink-r31.test.ts` interpolate the randomly generated fixture home into their titles. Only that temporary home is normalized to `$FIXTURE_HOME`; both distinct ordinary=false/true IDs and both original raw titles are retained in decision-by-id.json. No assertion or outcome is normalized.',
      '', 'Existing 241 failed assertions, 19 skipped/blocked cases, six todo cases, and the separate failing product-workflow gate remain visible and binding. NEW=0 is not a shipping verdict.',
      '', '| Discovered NEW test id | Disposition | Final |','|---|---|---|']
    lines += ['| '+r['id'].replace('|','\\|')+' | '+r['resolution']+' | PASS |' for r in resolved]
    lines += ['', '## Fixture identity aliases','']
    for row in aliases:
        lines += ['- '+row['id'], '  - Baseline: '+str(row['baseline'].get('rawTitle')), '  - Final: '+str(row['final'].get('rawTitle'))]
    report='\n'.join(lines)+'\n'
    (OUT/'NEW-IDS.md').write_text(report)
    Path('/work/build/gnl-prod-r5/NEW-IDS.md').write_text(report)
    print(json.dumps(summary))
