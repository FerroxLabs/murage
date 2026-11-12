#!/usr/bin/env python3
"""Compare complete Vitest shard results by file + full assertion name.

Missing reports, unfinished shards and source mismatches fail coverage checks;
red-on-both remains a defect list, never an implicit exemption.
"""
import argparse
import json
import pathlib


def relative(name):
    return name.split('/source/', 1)[-1].removeprefix('/work/')


def progress_results(shard, receipt):
    """Preserve exact IDs when a killed Vitest never flushes its JSON report."""
    path = shard / (receipt['label'] + '.jsonl')
    if not path.exists():
        return []
    files = {}
    for line in path.read_text().splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # a killed write may leave one trailing incomplete line
        file = relative(event['file'])
        tests = files.setdefault(file, {})
        previous = tests.get(event['fullName'])
        if previous and previous['status'] == 'failed' and event['status'] != 'failed':
            continue
        tests[event['fullName']] = event
    out = []
    for file, tests in files.items():
        assertions = []
        for name, event in tests.items():
            state = event['status']
            message = []
            if state in ('collected', 'running'):
                message = ['<TIMEOUT>' if state == 'running' else '<NOT RUN after timeout>']
                state = 'failed'
            elif state == 'failed':
                message = [error.get('message', str(error)) for error in (event.get('errors') or [])]
            assertions.append({'fullName': name, 'status': state, 'failureMessages': message})
        out.append({'name': file, 'status': 'failed' if any(a['status'] == 'failed' for a in assertions) else 'passed', 'assertionResults': assertions})
    return out


def read_side(root):
    root = pathlib.Path(root)
    expected, results, problems, file_results = set(), {}, [], {}
    revisions, inventories, scheduled = set(), [], []
    for index in range(8):
        shard = root / f'shard-{index}'
        try:
            audit = json.loads((shard / 'source.json').read_text())
            revisions.add(audit['sha'])
            if audit['mismatches'] or audit['tracked'] != audit['checked']:
                problems.append(f'shard-{index}: source completeness check failed')
            if not (shard / 'finished.json').exists() or (shard / 'runner-exit').read_text().strip() != '0':
                problems.append(f'shard-{index}: runner did not complete')
            listing = json.loads((shard / 'inventory.json').read_text())
            inventories.append(listing.get('all', listing['own']))
            inventory = listing['own']
            expected.update(inventory)
            scheduled.extend(inventory)
            receipts = json.loads((shard / 'receipts.json').read_text())
            for receipt in receipts:
                report = shard / (receipt['label'] + '.json')
                if not report.exists():
                    if receipt.get('timedOut'):
                        for file in progress_results(shard, receipt):
                            file_results.setdefault(file['name'], []).append(file)
                    continue
                data = json.loads(report.read_text())
                snapshots = data.get('snapshot', {})
                for field in ('added', 'updated', 'unchecked', 'filesRemoved'):
                    if snapshots.get(field, 0):
                        problems.append(f"shard-{index}/{receipt['label']}: snapshots {field}={snapshots[field]}")
                for file in data.get('testResults', []):
                    path = relative(file['name'])
                    file_results.setdefault(path, []).append(file)
            for path in inventory:
                if path in file_results:
                    continue
                timed_out = any(r['timedOut'] and path in r['batch'] for r in receipts)
                marker = '<TIMEOUT>' if timed_out else '<NO RESULT>'
                results[f'{path} :: {marker}'] = {'status': 'failed', 'file': path, 'message': marker}
                problems.append(f'{path}: {marker}')
        except (OSError, ValueError, KeyError) as error:
            problems.append(f'shard-{index}: {error}')
    if len(revisions) != 1:
        problems.append("shards do not agree on one source revision")
    if len(inventories) == 8 and any(inventory != inventories[0] for inventory in inventories[1:]):
        problems.append("shards do not agree on the full test inventory")
    if len(inventories) == 8:
        missing = set(inventories[0]) - expected
        extra = expected - set(inventories[0])
        if missing or extra:
            problems.append(f'shard partition mismatch: {len(missing)} unscheduled, {len(extra)} unknown files')
        if len(scheduled) != len(set(scheduled)):
            problems.append('test files scheduled on more than one shard')
    # Keep every attempt: retries may add coverage but cannot erase a red ID.
    for path, versions in file_results.items():
        for file in versions:
            assertions = file.get('assertionResults', [])
            bad = False
            for assertion in assertions:
                status = assertion['status']
                bad |= status == 'failed'
                key = f"{path} :: {assertion['fullName']}"
                row = {'file': path, 'status': status, 'message': '\n'.join(assertion.get('failureMessages', []))}
                # Duplicate full names are reported as one ID with the worst result.
                if key not in results or status == 'failed':
                    results[key] = row
            if file['status'] == 'failed' and not bad:
                results[f'{path} :: <FILE LOAD/SUITE FAILURE>'] = {'file': path, 'status': 'failed', 'message': file.get('message', '')}
    failures = {key for key, row in results.items() if row['status'] == 'failed'}
    return {'sha': next(iter(revisions)) if len(revisions) == 1 else None, 'expectedFiles': len(expected), 'reportedFiles': len(expected.intersection(file_results)), 'redFiles': len({results[key]['file'] for key in failures}), 'testIds': len(results), 'failures': sorted(failures), 'problems': problems}, results


def compare(base, head, output):
    output = pathlib.Path(output)
    output.mkdir(parents=True, exist_ok=True)
    sides, rows = {}, {}
    for name, root in [('base', base), ('head', head)]:
        sides[name], rows[name] = read_side(root)
        with (output / f'{name}-test-ids.jsonl').open('w') as stream:
            for key, row in sorted(rows[name].items()):
                stream.write(json.dumps({'id': key, **row}) + '\n')
        (output / f'{name}-red-test-ids.txt').write_text(''.join(key + '\n' for key in sides[name]['failures']))
    base_red, head_red = set(sides['base']['failures']), set(sides['head']['failures'])
    head_passed = {key for key, row in rows['head'].items() if row['status'] == 'passed'}
    resolved = base_red & head_passed
    removed_red = base_red - rows['head'].keys()
    # A changed skip/todo must not turn an executed base assertion into a
    # resolved defect or a green comparison. Stable platform skips are retained.
    nonexecution = {key for key, row in rows['base'].items()
                    if row['status'] in ('passed', 'failed') and key in rows['head']
                    and rows['head'][key]['status'] not in ('passed', 'failed')}
    sides['head']['problems'].extend(f'{key}: head did not execute a base assertion' for key in sorted(nonexecution))
    for name, ids in [('new-reds', head_red - base_red), ('red-on-both', head_red & base_red), ('resolved', resolved), ('removed-base-reds', removed_red), ('new-nonexecution', nonexecution)]:
        (output / f'{name}.txt').write_text(''.join(key + '\n' for key in sorted(ids)))
    complete = not sides['base']['problems'] and not sides['head']['problems']
    summary = {'complete': complete, **sides, 'newRedIds': len(head_red - base_red), 'redOnBothIds': len(head_red & base_red), 'resolvedIds': len(resolved), 'removedBaseRedIds': len(removed_red), 'newNonexecutionIds': len(nonexecution)}
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({key: value if not isinstance(value, dict) else {k: v for k, v in value.items() if k != 'failures'} for key, value in summary.items()}, indent=2))
    return (1 if head_red or removed_red else 0) if complete else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True)
    parser.add_argument('--head', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    raise SystemExit(compare(args.base, args.head, args.output))
