#!/usr/bin/env python3
"""Read-only admission receipt for two resolved product pins.

This is NOT a replacement for run.sh or a synthetic replay. In particular,
zero available requests means unknown card counts, never a zero-card result.
No product is launched before corpus admission; no credentials are used.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location('nolim_extract', Path(__file__).with_name('extract.py'))
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)

def git(repository, *args):
    return subprocess.check_output(['git', '-C', str(repository), *args], stderr=subprocess.DEVNULL, timeout=30).decode().strip()

def pin(repository, ref):
    sha = git(repository, 'rev-parse', '--verify', '--end-of-options', ref+'^{commit}')
    if not re.fullmatch('[a-f0-9]{40}', sha): raise ValueError('SHA')
    package = export.strict(git(repository, 'show', sha+':package.json'))
    version = package.get('version')
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-z0-9.]+)?', version): raise ValueError('VERSION')
    return {'sourceSha':sha, 'treeSha':git(repository,'rev-parse',sha+'^{tree}'), 'version':version}

def inspect(corpus):
    corpus = export.no_links(corpus)
    if corpus.stat().st_mode & 0o777 != 0o700: raise ValueError('DIRECTORY-MODE')
    for path in corpus.iterdir():
        if path.lstat().st_mode & 0o777 != 0o600: raise ValueError('FILE-MODE')
    data = export.bundle_bytes(corpus)
    for blob in data.values(): export.scan(blob)
    m = export.strict(data['manifest.json'])
    coverage = export.strict(data['coverage.json'])
    requests = [export.strict(line) for line in data['requests.jsonl'].splitlines() if line.strip()]
    diagnostics = [export.strict(line) for line in data['diagnostics.jsonl'].splitlines() if line.strip()]
    if len(requests) != m['cases'] or len(diagnostics) != m['diagnostics']: raise ValueError('COUNTS')
    blockers = []
    if not requests: blockers.append('MISSING-REQUEST-ENVELOPES')
    if m['missing']: blockers.append('MISSING-DIAGNOSTIC-MAPPINGS')
    if m['quarantines']: blockers.append('QUARANTINED-DIAGNOSTICS')
    if not m['fidelity']: blockers.append('UNVERIFIED-FIDELITY')
    if not m['originComplete']: blockers.append('MISSING-AUTHENTICATED-ORIGIN-AND-LINEAGE')
    if not coverage.get('chunkContextAvailable'): blockers.append('MISSING-CHUNK-CONTEXT')
    if not m['redactionPass']: blockers.append('REDACTION-FAILED')
    if m['policy']['hookDecision'] != 'superseded': blockers.append('POLICY-CONFLICT')
    if not all(m['review'].values()): blockers.append('MISSING-INDEPENDENT-REVIEWS')
    return {'corpusDigest':export.bundle_digest(data), 'policyDigest':m['policy']['digest'],
            'requestEnvelopes':len(requests), 'diagnostics':len(diagnostics),
            'quarantined':m['quarantines'], 'blockers':blockers}

def comparison(admission, baseline, product):
    if baseline['version'] != '1.0.18': raise ValueError('BASE-VERSION')
    # Even a complete census must go through the faithful J/W collector.
    # This command only records admission, never manufactures behavioural RED.
    reason = 'CORPUS-INCOMPLETE' if admission['blockers'] else 'REPLAY-EXECUTION-REQUIRED'
    def attempt(source):
        return {**source, 'status':'INCOMPLETE', 'reason':reason,
                'receiptType':'infrastructure-failure', 'executedRequests':0,
                'ownerTurnCards':None, 'ownerTurnCardsByReason':None,
                'behaviouralRedEstablished':False}
    return {'schema':'murage.nolim-replay-admission.v1', 'status':'INCOMPLETE',
            'recordedAt':datetime.now(timezone.utc).isoformat(), **admission,
            'baseline':attempt(baseline), 'product':attempt(product),
            'releaseEligible':False, 'shippedArtifactMappingVerified':False}

def main():
    parser = export.PrivateParser(add_help=False)
    parser.add_argument('--repository', default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument('--corpus', required=True)
    parser.add_argument('--product-ref', required=True)
    parser.add_argument('--baseline-ref', default='origin/int1018/pin54b')
    parser.add_argument('--out', required=True)
    try:
        args = parser.parse_args()
        result = comparison(inspect(Path(args.corpus)), pin(args.repository,args.baseline_ref), pin(args.repository,args.product_ref))
        out = export.private_dir(args.out)
        export.write(out/'comparison.json',export.encoded(result))
        summary = ('OPEN CORPUS-INCOMPLETE\n' if result['blockers'] else 'OPEN REPLAY-EXECUTION-REQUIRED\n')
        summary += '\nNo product decisions executed. Owner-turn card counts and reason counts are unavailable for both pins.\n'
        summary += 'A diagnostic reason census cannot substitute for original requests, authenticated origins, or observed card insertions.\n'
        summary += '\nBaseline: '+result['baseline']['sourceSha']+'\nProduct: '+result['product']['sourceSha']+'\n'
        summary += '\nBlockers:\n'+''.join('- '+x+'\n' for x in result['blockers'])
        export.write(out/'SUMMARY.md',summary.encode())
        print(json.dumps({'status':'INCOMPLETE','requestEnvelopes':result['requestEnvelopes'],'diagnostics':result['diagnostics'],'quarantined':result['quarantined']}))
        return 2
    except BaseException:
        print('{"status":"INCOMPLETE","errors":1}')
        return 3

if __name__ == '__main__': sys.exit(main())
