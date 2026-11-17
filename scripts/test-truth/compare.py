#!/usr/bin/env python3
"""Compare complete Vitest shard results by file + full assertion name.

Missing reports, unfinished shards and source mismatches fail coverage checks;
red-on-both remains a defect list, never an implicit exemption.
"""
import argparse
import hashlib
import json
import pathlib


def relative(name):
    return name.split('/source/', 1)[-1].removeprefix('/work/')


def read_side(root, expected_sha=None, side=None):
    root = pathlib.Path(root)
    expected, results, problems, file_results = set(), {}, [], {}
    observations, observed_failures, infrastructure = {}, {}, []
    corrections, recovered = set(), set()
    revisions, inventories, scheduled = set(), [], []

    def failure(key, path, message, label, evidence):
        row = observed_failures.setdefault(key, {'file': path, 'status': 'failed', 'messages': [], 'failedAttempts': []})
        if message and message not in row['messages']:
            row['messages'].append(message)
        attempt = {'label': label, 'evidence': evidence}
        if attempt not in row['failedAttempts']:
            row['failedAttempts'].append(attempt)

    for index in range(8):
        shard = root / f'shard-{index}'
        try:
            audit = json.loads((shard / 'source.json').read_text())
            revisions.add(audit['sha'])
            if expected_sha is not None and audit['sha'] != expected_sha:
                problems.append(f'shard-{index}: source revision differs from requested {expected_sha}')
            if side is not None and audit.get('side', side) != side:
                problems.append(f'shard-{index}: source is labelled for the wrong comparison side')
            if audit['mismatches'] or audit['tracked'] != audit['checked']:
                problems.append(f'shard-{index}: source completeness check failed')
            if not (shard / 'finished.json').exists() or (shard / 'runner-exit').read_text().strip() != '0':
                problems.append(f'shard-{index}: runner did not complete')
            else:
                finished = json.loads((shard / 'finished.json').read_text())
                if finished.get('sha', audit['sha']) != audit['sha'] or (side is not None and finished.get('side', side) != side):
                    problems.append(f'shard-{index}: completion receipt differs from source or side')
            listing = json.loads((shard / 'inventory.json').read_text())
            inventories.append(listing.get('all', listing['own']))
            inventory = listing['own']
            if expected.intersection(inventory):
                problems.append(f'shard-{index}: duplicate shard assignment')
            expected.update(inventory)
            scheduled.extend(inventory)
            receipts = json.loads((shard / 'receipts.json').read_text())
            corrected = {path for row in receipts if row.get('fixtureRecheck') for path in row['batch']}
            fixture_inventory = shard / 'fixture-inventory.json'
            if fixture_inventory.exists():
                corrected.update(json.loads(fixture_inventory.read_text())['own'])
                fixture_source = json.loads((shard / 'fixture-source.json').read_text())
                if fixture_source['sha'] != audit['sha'] or fixture_source['mismatches'] or fixture_source['tracked'] != fixture_source['checked'] or (side is not None and fixture_source.get('side', side) != side):
                    problems.append(f'shard-{index}: corrected-input source check failed')
            if corrected - set(inventory):
                problems.append(f'shard-{index}: corrected-input files outside shard inventory')
            corrections.update(corrected)
            active_receipts = []
            for receipt in receipts:
                # A prepared-input recheck replaces the old input cohort even
                # when it emits no JSON. Never fall back to its stale report.
                active = {path for path in receipt['batch'] if path not in corrected or receipt.get('fixtureRecheck')}
                if not active:
                    continue
                active_receipts.append((receipt, active))
                report = shard / (receipt['label'] + '.json')
                try:
                    data = json.loads(report.read_text()) if report.exists() else {}
                except (OSError, ValueError) as error:
                    problems.append(f'shard-{index}/{report.name}: {error}')
                    data = {}
                snapshots = data.get('snapshot', {})
                for field in ('added', 'updated', 'unchecked', 'filesRemoved'):
                    if snapshots.get(field, 0):
                        problems.append(f"shard-{index}/{receipt['label']}: snapshots {field}={snapshots[field]}")
                covered, progress_names = set(), {}
                for file in data.get('testResults', []):
                    path = relative(file['name'])
                    if path not in active:
                        continue
                    covered.add(path)
                    file_results[path] = file
                    bad = False
                    for assertion in file.get('assertionResults', []):
                        # Vitest JSON omits empty title components; the saved
                        # progress stream joins them with spaces. Reconcile
                        # only names proven by this report's title metadata,
                        # never trim meaningful whitespace from test IDs.
                        if 'ancestorTitles' in assertion and 'title' in assertion:
                            observed = f"{path} :: " + ' '.join([*assertion['ancestorTitles'], assertion['title']])
                            canonical = f"{path} :: {assertion['fullName']}"
                            progress_names.setdefault(observed, set()).add(canonical)
                        if assertion['status'] == 'failed':
                            bad = True
                            failure(f"{path} :: {assertion['fullName']}", path, '\n'.join(assertion.get('failureMessages', [])), receipt['label'], 'json')
                    if file['status'] == 'failed' and not bad:
                        failure(f'{path} :: <FILE LOAD/SUITE FAILURE>', path, file.get('message', ''), receipt['label'], 'json')
                missing = sorted(active - covered)
                # Assertion coverage cannot prove that teardown or unhandled-error
                # processing succeeded. Keep every active attempt's process and
                # report failures even if a later retry returns passing bodies.
                report_failures = {field: data[field] for field in (
                    'numFailedTests', 'numFailedTestSuites', 'numUnhandledErrors',
                    'numRuntimeErrorTestSuites') if data.get(field, 0)}
                if data.get('success') is False:
                    report_failures['success'] = False
                failed_exit = 'code' in receipt and receipt['code'] != 0
                if missing or receipt.get('timedOut') or receipt.get('signal') or failed_exit or report_failures:
                    infrastructure.append({'shard': index, 'label': receipt['label'], 'missingReports': missing,
                                           'code': receipt.get('code'), 'reportFailures': report_failures,
                                           'timedOut': receipt.get('timedOut', False), 'signal': receipt.get('signal'),
                                           'activeTestIds': receipt.get('activeTestIds', [])})
                progress = shard / (receipt['label'] + '.jsonl')
                if progress.exists():
                    for number, line in enumerate(progress.read_text().splitlines(), 1):
                        try:
                            event = json.loads(line)
                            path = relative(event['file'])
                            if path not in active:
                                continue
                            key = f"{path} :: {event['fullName']}"
                            candidates = progress_names.get(key, set())
                            if len(candidates) == 1:
                                key = next(iter(candidates))
                            elif len(candidates) > 1:
                                problems.append(f'{key}: ambiguous progress name in JSON title metadata')
                            observations[key] = {'file': path, 'observedStatus': event['status']}
                            if event['status'] == 'failed':
                                errors = event.get('errors') or []
                                message = '\n'.join(str(error.get('message', error)) if isinstance(error, dict) else str(error) for error in errors)
                                failure(key, path, message, receipt['label'], 'progress')
                        except (ValueError, KeyError, TypeError) as error:
                            problems.append(f'shard-{index}/{progress.name}:{number}: invalid progress: {error}')
            for path in inventory:
                if path in file_results:
                    continue
                timed_out = any(row.get('timedOut') and path in active for row, active in active_receipts)
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
        if not inventories[0]:
            problems.append('the full test inventory is empty')
        if len(scheduled) != len(set(scheduled)):
            problems.append('test files scheduled on more than one shard')
    for path, file in file_results.items():
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
    for key, observed in observations.items():
        if key not in results:
            results[key] = {**observed, 'status': 'unverified', 'message': 'No authoritative JSON assertion result; progress observation only'}
            if observed['file'] in file_results:
                problems.append(f'{key}: collected ID absent from authoritative report')
    for key, observed in observed_failures.items():
        latest = results.get(key, {})
        if latest.get('status') == 'passed' or ('<FILE LOAD/SUITE FAILURE>' in key and file_results.get(observed['file'], {}).get('status') == 'passed'):
            recovered.add(key)
        results[key] = {name: value for name, value in observed.items() if name != 'messages'}
        results[key]['message'] = '\n'.join(observed['messages'])
        if key in recovered:
            results[key]['recoveryStatus'] = 'passed after an observed failure'
    failures = {key for key, row in results.items() if row['status'] == 'failed'}
    return {'sha': next(iter(revisions)) if len(revisions) == 1 else None, 'requestedSha': expected_sha, 'expectedFiles': len(expected), 'reportedFiles': len(expected.intersection(file_results)), 'redFiles': len({results[key]['file'] for key in failures}), 'testIds': len(results), 'failures': sorted(failures), 'unverifiedIds': sum(row['status'] == 'unverified' for row in results.values()), 'recoveredAfterFailure': sorted(recovered), 'correctedInputFiles': sorted(corrections), 'infrastructureFailures': infrastructure, 'problems': problems}, results


def compare(base, head, output, base_sha, head_sha):
    output = pathlib.Path(output)
    output.mkdir(parents=True, exist_ok=True)
    sides, rows = {}, {}
    for name, root, sha in [('base', base, base_sha), ('head', head, head_sha)]:
        sides[name], rows[name] = read_side(root, sha, name)
        with (output / f'{name}-test-ids.jsonl').open('w') as stream:
            for key, row in sorted(rows[name].items()):
                stream.write(json.dumps({'id': key, **row}) + '\n')
        (output / f'{name}-red-test-ids.txt').write_text(''.join(key + '\n' for key in sides[name]['failures']))
        (output / f'{name}-unverified-test-ids.txt').write_text(''.join(key + '\n' for key, row in sorted(rows[name].items()) if row['status'] == 'unverified'))
        (output / f'{name}-recovered-after-failure.txt').write_text(''.join(key + '\n' for key in sides[name]['recoveredAfterFailure']))
        (output / f'{name}-infrastructure.json').write_text(json.dumps(sides[name]['infrastructureFailures'], indent=2) + '\n')
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
    summary = {'complete': complete, 'comparisonToolSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(), **sides, 'newRedIds': len(head_red - base_red), 'redOnBothIds': len(head_red & base_red), 'resolvedIds': len(resolved), 'removedBaseRedIds': len(removed_red), 'newNonexecutionIds': len(nonexecution)}
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({key: value if not isinstance(value, dict) else {k: v for k, v in value.items() if k != 'failures'} for key, value in summary.items()}, indent=2))
    return (1 if head_red or removed_red or sides['base']['infrastructureFailures'] or sides['head']['infrastructureFailures'] else 0) if complete else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True)
    parser.add_argument('--head', required=True)
    parser.add_argument('--base-sha', required=True, help='Exact requested source revision, independent of result labels')
    parser.add_argument('--head-sha', required=True, help='Exact requested source revision, independent of result labels')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    raise SystemExit(compare(args.base, args.head, args.output, args.base_sha, args.head_sha))
