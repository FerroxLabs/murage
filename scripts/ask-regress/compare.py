"""Compare every reported test ID, including duplicate titles and suite failures."""
import collections, json, pathlib
root = pathlib.Path('evidence/ask-regress/raw/full')
def load(phase):
    tests = {}; suites = []; exits = []; expected_files=set(); actual_files=set()
    for shard in range(1,9):
        exit_row = json.loads((root / f'{phase}-{shard}.exit.json').read_text())
        exits.append(exit_row)
        if exit_row['exit'] not in [0,1] or not exit_row['report']:
            raise RuntimeError(f'Incomplete shard: {exit_row}')
        inventory_path=root / f'{phase}-{shard}.inventory.json'
        if inventory_path.exists():
            inventory=json.loads(inventory_path.read_text())
            expected_files.update(row['file'].split(f'/ask-full-{phase}-{shard}/')[-1]for row in inventory)
        report = json.loads((root / f'{phase}-{shard}.json').read_text())
        assertion_count=sum(len(s['assertionResults']) for s in report['testResults'])
        if assertion_count!=report['numTotalTests']:raise RuntimeError(f'Incomplete assertion report: {phase}-{shard}')
        if report.get('snapshot',{}).get('didUpdate'):raise RuntimeError(f'Snapshots updated during {phase}-{shard}')
        for suite in report['testResults']:
            path = suite['name'].split(f'/ask-full-{phase}-{shard}/')[-1]
            if path in actual_files:raise RuntimeError(f'Duplicate suite file across shards: {path}')
            actual_files.add(path)
            occurrences = collections.Counter()
            if suite['status'] == 'failed' and (suite.get('message') or not any(t['status']=='failed'for t in suite['assertionResults'])):
                suites.append({'file':path,'message':suite.get('message','')})
            for test in suite['assertionResults']:
                name=test['fullName'].replace(f'/tmp/ask-full-{phase}-{shard}','<source>'); occurrences[name]+=1
                key = f'{path} :: {name} :: {occurrences[name]}'
                if key in tests: raise RuntimeError(f'Duplicate shard ID: {key}')
                tests[key] = {'rawFullName':test['fullName'],'status':test['status'], 'failureMessages':test.get('failureMessages',[])}
    global_path=root / f'{phase}.inventory-all.json'
    if global_path.exists():
        complete=json.loads(global_path.read_text());expected_files=set(complete['files'])
        if any(row.get('sourceCommit')!=complete['sourceCommit']for row in exits):raise RuntimeError('Mixed source commits in '+phase)
    else:
        if any(not(root / f'{phase}-{n}.inventory.json').exists()for n in range(1,9)):raise RuntimeError('Missing independent inventory for '+phase)
    missing=sorted(expected_files-actual_files)
    unexpected=sorted(actual_files-expected_files)
    if unexpected:raise RuntimeError(f'Unexpected {phase} file coverage: {unexpected}')
    if missing:raise RuntimeError(f'Incomplete {phase} file coverage: {missing}')
    return tests,suites,exits
base,base_suites,base_exits=load('base');head,head_suites,head_exits=load('head')
failed=lambda tests:{key for key,value in tests.items() if value['status']=='failed'}
new=sorted(failed(head)-failed(base));removed=sorted(base.keys()-head.keys())
summary={'baseStatus':dict(collections.Counter(t['status'] for t in base.values())),
 'headStatus':dict(collections.Counter(t['status'] for t in head.values())),
 'newFailures':new,'fixedFailures':sorted(key for key in failed(base) if key in head and head[key]['status']=='passed'),
 'inheritedFailures':sorted(failed(base)&failed(head)), 'removedIDs':removed,
 'newlyUnexecutedIDs':sorted(key for key,value in head.items() if value['status'] not in ['passed','failed'] and (key not in base or base[key]['status'] in ['passed','failed'])),
 'changedStatuses':{key:{'base':base[key]['status'],'head':head[key]['status']}for key in sorted(base.keys()&head.keys())if base[key]['status']!=head[key]['status']},
 'addedIDs':sorted(head.keys()-base.keys()), 'baseSuiteFailures':base_suites,'headSuiteFailures':head_suites,
 'newSuiteFailureFiles':sorted({s['file']for s in head_suites}-{s['file']for s in base_suites}),
 'baseExits':base_exits,'headExits':head_exits}
for phase,tests in [('base',base),('head',head)]:
    (root / f'{phase}-tests-by-id.json').write_text(json.dumps(tests,indent=2)+'\n')
(root / 'comparison.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:(v if k.endswith('Status') else len(v))for k,v in summary.items()},indent=2))
