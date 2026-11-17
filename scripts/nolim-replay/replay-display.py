#!/usr/bin/env python3
"""Offline display corpus runner. Aggregate output only; never release admission."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
from display_cards import BASE, load, load_bytes
spec=importlib.util.spec_from_file_location('extract',Path(__file__).with_name('extract.py'))
api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)

def compare(base,tip):
    if len(base)!=len(tip): raise ValueError('ROWS')
    totals={}
    for cohort in ('owner','routine','non-owner'):
        selected=[(a,b) for a,b in zip(base,tip) if a['cohort']==cohort]
        for a,b in selected:
            if (a['ordinal'],a['cohort'],a['status'])!=(b['ordinal'],b['cohort'],b['status']): raise ValueError('BINDING')
        judged=[(a,b) for a,b in selected if a['status']=='judged']
        def counts(side):
            reasons={}; rules={}; exceptions={}
            for pair in judged:
                r=pair[side]
                if r['cards']:
                    reasons[r['reason']]=reasons.get(r['reason'],0)+r['cards']
                    rule=r.get('rule','other');rules[rule]=rules.get(rule,0)+r['cards']
                    exception=r.get('exceptionEvidence','not-established');exceptions[exception]=exceptions.get(exception,0)+r['cards']
            return {'cards':sum(reasons.values()),'byReason':reasons,'byRule':rules,'exceptionEvidence':exceptions,
              'cardsWithoutExceptionEvidence':sum(n for kind,n in exceptions.items() if kind!='wipe-list'),'refusals':sum(pair[side].get('refusals',0) for pair in judged)}
        failed=sum(a['parityDigest']!=b['parityDigest'] for a,b in judged)
        unavailable={}
        for a,b in selected:
            if a['status']!='judged': unavailable[a['status']]=unavailable.get(a['status'],0)+1
        totals[cohort]={'rows':len(selected),'judged':len(judged),'unavailable':len(selected)-len(judged),'unavailableByReason':unavailable,'base':counts(0),'tip':counts(1),
          'parityRequired':cohort=='non-owner','parityDifferences':failed,
          'parity':'NOT-REQUIRED' if cohort!='non-owner' else 'FAIL' if failed else 'INCOMPLETE' if len(judged)!=len(selected) or not selected else 'PASS'}
    return totals

def owner_target(cohorts):
    eligible=[cohorts[name] for name in ('owner','routine') if cohorts[name]['rows']]
    # Display evidence cannot certify delivery, holds or truncated input.
    return 'NOT-ESTABLISHED' if not eligible or any(c['unavailable'] or c['tip']['cardsWithoutExceptionEvidence'] or c['tip']['refusals'] for c in eligible) else 'MET-FOR-JUDGED-DISPLAY-ONLY'

def run(corpus,pins,tip,out,stream=False):
    if not re.fullmatch('[a-f0-9]{40}',tip): raise ValueError('PIN')
    if stream:
        payload=sys.stdin.buffer.read(8*1024*1024+1)
        if len(payload)>8*1024*1024: raise ValueError('STREAM-LIMIT')
        envelope=api.strict(payload)
        if set(envelope)!={'manifest','files'} or not isinstance(envelope['manifest'],str) or not isinstance(envelope['files'],dict) or any(not isinstance(v,str) for v in envelope['files'].values()): raise ValueError('STREAM')
        manifest_bytes=envelope['manifest'].encode()
        manifest,rows=load_bytes(manifest_bytes,{n:v.encode() for n,v in envelope['files'].items()},api)
    else:
        manifest,rows=load(corpus,api)
        manifest_bytes=api.read_private(corpus/'manifest.json')[0]
    api.private_dir(out)
    results=[]; bindings=[]
    for label,sha in [('base',BASE),('tip',tip)]:
        source=api.no_links(pins/sha)
        receipt=api.strict(api.read_private(source/'display-pin.json')[0])
        if receipt['sourceSha']!=sha or receipt['overlay']!='scripts/nolim-replay/display-judge.ts': raise ValueError('PIN')
        for name,expected in receipt['files'].items():
            if not (source/name).resolve().is_relative_to(source.resolve()) or api.digest((source/name).read_bytes())!=expected: raise ValueError('PIN-MODIFIED')
        if receipt['files'][receipt['overlay']]!=api.digest(Path(__file__).with_name('display-judge.ts').read_bytes()): raise ValueError('OVERLAY')
        output=(out/(label+'.json')).resolve()
        result=subprocess.run(['node','--experimental-strip-types',str(source/receipt['overlay']),str(output)],input=api.encoded(rows),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
        if result.returncode or result.stdout: raise ValueError('JUDGE')
        results.append(api.strict(api.read_private(output)[0]))
        bindings.append({'sourceSha':sha,'pinReceiptSha256':api.digest(api.read_private(source/'display-pin.json')[0]),'adapterSha256':receipt['files'][receipt['overlay']]})
    report={'schema':'murage.nolim-display-comparison.v2','fidelity':'DISPLAY-FIDELITY','mode':'judge-counterfactual',
      'baseSha':BASE,'tipSha':tip,'bindings':bindings,'corpusManifestSha256':api.digest(manifest_bytes),
      'rows':len(rows),'completeWindow':manifest['completeWindow'],'correlation':'APPROXIMATE',
      'assumptions':{'level':'unlimited','routineCeiling':'unlimited','driver':'claude','shell':'posix','summary':'display-command-or-input','ownerStarted':'derived-from-stored-card-class-for-counterfactual-only','outsideRead':'none-assumed','grants':'empty','environment':'unavailable-fixture'},
      'historicalOwnerTurnCards':None,'actualWorkflowCards':None,'releaseEligible':False,'cohorts':compare(*results)}
    report['ownerTarget']=owner_target(report['cohorts'])
    report['exceptionEvidenceBasis']='named-wipe-rule-or-product-n2-fact-only'
    report['independentTargetValidation']=False
    api.write(out/'report.json',api.encoded(report))
    print(json.dumps({'rows':len(rows),'report':str(out/'report.json'),'cohorts':report['cohorts']}))
    return 2 if not rows or not manifest['completeWindow'] or report['ownerTarget']=='NOT-ESTABLISHED' or any(c['parityRequired'] and c['parity']!='PASS' for c in report['cohorts'].values()) else 0

if __name__=='__main__':
    try:
        p=argparse.ArgumentParser();source=p.add_mutually_exclusive_group(required=True);source.add_argument('--corpus',type=Path);source.add_argument('--corpus-stdin',action='store_true');p.add_argument('--pins',type=Path,required=True);p.add_argument('--tip',required=True);p.add_argument('--out',type=Path,required=True)
        a=p.parse_args();code=run(a.corpus,a.pins,a.tip,a.out,a.corpus_stdin)
    except BaseException:
        print('{"errors":1}');code=3
    sys.exit(code)
