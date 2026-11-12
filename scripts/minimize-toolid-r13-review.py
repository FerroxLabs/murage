import json,pathlib,sys,hashlib
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from importlib import import_module
f=import_module('fuzz-toolid-r13')
rows=json.loads((f.ROOT/'server/testing/fixtures/no-limits-r13.json').read_text())
port=f.Port()
try:
    for row in rows:
        if row['id'].startswith(('R13-import','R13-from','R13-bytes-','R13-fstring','R13-leading','R13-adjacent','R13-keyword-effects')):
            candidate={'identity':row['identity'],'payload':row['payload']}
            if f.outcome(candidate)!='run' and port.batch([candidate])[0]=='run':
                small=f.minimize(port,candidate);small['expected']=f.outcome(small)
                small['id']='R13-FUZZ-'+hashlib.sha256(json.dumps(small,sort_keys=True).encode()).hexdigest()[:16]
                with (f.ROOT/'server/testing/fixtures/no-limits-r13-fuzz.jsonl').open('a') as out:out.write(json.dumps(small)+'\n')
                print(json.dumps(small),flush=True)
finally:port.close()
