#!/usr/bin/env python3
"""Read the private seal/independent labels via a pipe; print counts only."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
from display_cards import load_bytes
spec=importlib.util.spec_from_file_location('extract',Path(__file__).with_name('extract.py'))
api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
try:
    payload=sys.stdin.buffer.read(8*1024*1024+1)
    if len(payload)>8*1024*1024: raise ValueError('STREAM-LIMIT')
    envelope=api.strict(payload)
    manifest,rows=load_bytes(envelope['manifest'].encode(),{n:v.encode() for n,v in envelope['files'].items()},api)
    lines=envelope['labels'].encode().splitlines(keepends=True)
    parsed=[api.strict(line) for line in lines]
    seals=[r for r in parsed if set(r)=={'sha256'}]
    if len(seals)!=1 or seals[0]['sha256']!=api.digest(b''.join(line for line,r in zip(lines,parsed) if 'id' in r)): raise ValueError('LABEL-SEAL')
    labels=[r for r in parsed if 'id' in r]
    if len(labels)!=len(rows) or {r['id'] for r in labels}!={r['id'] for r in rows}: raise ValueError('LABELS')
    label_counts={}
    for r in labels:
        if r['verdict'] not in {a+'|none|'+s for a in ('owner','owner-routine','other') for s in ('available','unavailable:input')}: raise ValueError('LABEL')
        label_counts[r['verdict']]=label_counts.get(r['verdict'],0)+1
    by_id={r['id']:r for r in labels}
    for row in rows:
        cc=row['cardClass']
        actor='owner-routine' if cc['origin']=='routine' or cc['automated']==1 else 'owner' if cc['origin']=='owner' and cc['unattended']==0 and cc['automated']==0 else 'other'
        availability='unavailable:input' if row['toolInputTruncated']==1 or row['boundedToolInput'] is None else 'available'
        if by_id[row['id']]['verdict']!=actor+'|none|'+availability: raise ValueError('LABEL-BINDING')
    tip=sys.argv[1]
    if not re.fullmatch('[a-f0-9]{40}',tip): raise ValueError('PIN')
    source=Path(sys.argv[2] if len(sys.argv)>2 else '.nolim-evidence/early/pins')/tip
    receipt=api.strict((source/'display-pin.json').read_bytes())
    if receipt['sourceSha']!=tip: raise ValueError('PIN')
    for name,expected in receipt['files'].items():
        if not (source/name).resolve().is_relative_to(source.resolve()) or api.digest((source/name).read_bytes())!=expected: raise ValueError('PIN-MODIFIED')
    run=subprocess.run(['node','--experimental-strip-types',str(Path(__file__).with_name('engine-matrix.ts')),str(source)],input=api.encoded(rows),capture_output=True,timeout=240)
    if run.returncode: raise ValueError('JUDGE')
    result=api.strict(run.stdout)
    result.update(sourceSha=tip,rows=len(rows),labels=label_counts,corpusManifestSha256=api.digest(envelope['manifest'].encode()))
    print(json.dumps(result))
except BaseException:
    print('{"errors":1}');sys.exit(3)
