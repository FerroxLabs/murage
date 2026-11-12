"""Grammar minimization of the two resource witnesses: find the first unsafe
repeat count, verify its predecessor, and check the original port at that count.
"""
import json,pathlib,subprocess,sys
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from importlib import import_module
f=import_module('fuzz-toolid-r13')
worker="""import {createInterface} from 'node:readline';
import {judge} from './.r13-baseline/server/no-limits-code.ts';
for await (const line of createInterface({input:process.stdin})) {
 const r=judge('python',JSON.parse(line)); process.stdout.write(JSON.stringify(r.cls?'card:'+r.cls:'run')+'\\n');
}
"""
child=subprocess.Popen(['node','--experimental-strip-types','--input-type=module','-e',worker],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,cwd=f.ROOT)
records=[]
try:
    rows=json.loads((f.ROOT/'server/testing/fixtures/no-limits-r13.json').read_text())
    for rid,prefix,text,suffix,upper in [('R13-min-parameter-budget','def f(','a,','): pass',400000),('R13-min-keyword-budget','','f(a=0)\n','',80000)]:
        def source(count):return prefix+text*count+suffix
        def oracle(count):return f.outcome({'identity':'python','payload':source(count)})
        lo,hi=0,upper
        assert oracle(hi)=='card:cut'
        while lo+1<hi:
            mid=(lo+hi)//2
            if oracle(mid)=='card:cut':hi=mid
            else:lo=mid
        child.stdin.write(json.dumps(source(hi))+'\n');child.stdin.flush()
        old=json.loads(child.stdout.readline());assert old=='run'
        assert oracle(lo)=='run' and oracle(hi)=='card:cut'
        records.append({'id':rid,'minimal_repeat_count':hi,'predecessor':lo,'oracle':'card:cut','baseline_port':old})
        rows.append({'id':rid,'identity':'python','repeat':{'prefix':prefix,'text':text,'count':hi,'suffix':suffix},'expected':'card:cut','minimization':'first repeat count crossing the reference work budget'})
    (f.ROOT/'server/testing/fixtures/no-limits-r13.json').write_text(json.dumps(rows,indent=2)+'\n')
    (f.ROOT/'evidence/bld3-toolid-s4a/work-minimized.json').write_text(json.dumps(records,indent=2)+'\n')
    print(json.dumps(records))
finally:
    child.stdin.close();child.wait(timeout=30)
