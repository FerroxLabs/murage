#!/usr/bin/env python3
"""Host preparation only: git snapshots, never execute product or read app data."""
import hashlib
import argparse
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
BASE='292df98d80a1c55db3e6f232166fc05162b632ab'
root=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser()
parser.add_argument('tip')
parser.add_argument('--out',type=Path,default=root/'.nolim-evidence/bld4/display-pins')
args=parser.parse_args()
tip=args.tip
if not re.fullmatch('[a-f0-9]{40}',tip): raise SystemExit('PIN')
for sha in dict.fromkeys([BASE,tip]):
    target=args.out/sha
    if target.exists():
        receipt=json.loads((target/'display-pin.json').read_text())
        if receipt['sourceSha']!=sha or any(hashlib.sha256((target/name).read_bytes()).hexdigest()!=expected for name,expected in receipt['files'].items()) or receipt['files']['scripts/nolim-replay/display-judge.ts']!=hashlib.sha256((root/'scripts/nolim-replay/display-judge.ts').read_bytes()).hexdigest(): raise SystemExit('PIN-MODIFIED')
        print(json.dumps({'reusedPins':1,'path':str(target)}))
        continue
    target.mkdir(parents=True)
    data=subprocess.check_output(['git','-C',str(root),'archive',sha])
    with tarfile.open(fileobj=io.BytesIO(data)) as archive: archive.extractall(target,filter='data')
    hashes={str(p.relative_to(target)):hashlib.sha256(p.read_bytes()).hexdigest() for p in target.rglob('*') if p.is_file()}
    overlay='scripts/nolim-replay/display-judge.ts'
    (target/overlay).parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(root/overlay,target/overlay)
    # The copied adapter is the only changed executable; policy stays pinned.
    hashes[overlay]=hashlib.sha256((target/overlay).read_bytes()).hexdigest()
    (target/'display-pin.json').write_text(json.dumps({'sourceSha':sha,'archiveSha256':hashlib.sha256(data).hexdigest(),'overlay':overlay,'files':hashes})+'\n')
    print(json.dumps({'pinFiles':len(hashes),'path':str(target)}))
