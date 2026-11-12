#!/usr/bin/env python3
"""Grammar generation + corpus mutations; oracle and port only read inert data.
Run exclusively in the job's networkless container. Reproducible seed, batched
IPC, no oracle cache, no evaluated/generated payloads. Each unsafe witness is
reduced with ddmin and appended to an immutable fixture log before failing.
"""
import argparse, hashlib, json, pathlib, random, subprocess, sys, time, warnings
warnings.filterwarnings('ignore')
ROOT = pathlib.Path(__file__).resolve().parents[1]
FIX = ROOT / 'server/testing/fixtures/no-limits-r12'
sys.path.insert(0, str(FIX))
import judge as oracle

def outcome(row):
    r = oracle.judge(row['identity'], row['payload'], row.get('mode', 'nl'))
    return r.verdict + (':' + r.cls if r.cls else '')

class Port:
    def __init__(self):
        self.child = subprocess.Popen(['node', '--experimental-strip-types', 'scripts/fuzz-toolid-r13-worker.ts'], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    def batch(self, rows):
        self.child.stdin.write(json.dumps(rows, ensure_ascii=True) + '\n'); self.child.stdin.flush()
        line = self.child.stdout.readline()
        if not line: raise RuntimeError('port worker exited: ' + str(self.child.poll()))
        return json.loads(line)
    def close(self):
        self.child.stdin.close()
        if self.child.wait(timeout=30): raise RuntimeError('port worker failure')

def minimize(port, row):
    # Preserve identity/mode; delta-debug the actual string, or each JSON leaf.
    def unsafe(candidate):
        return outcome(candidate) != 'run' and port.batch([candidate])[0] == 'run'
    def ddmin(value, build):
        n = 2
        while len(value) >= 2:
            size = (len(value) + n - 1) // n
            for start in range(0, len(value), size):
                candidate = value[:start] + value[start+size:]
                if unsafe(build(candidate)):
                    value = candidate; n = max(2, n-1); break
            else:
                if n >= len(value): break
                n = min(len(value), n*2); continue
        return value
    row = dict(row)
    if isinstance(row['payload'], str): row['payload'] = ddmin(row['payload'], lambda s: {**row, 'payload': s})
    elif isinstance(row['payload'], dict):
        value = dict(row['payload'])
        for key in list(value):
            candidate = {k:v for k,v in value.items() if k != key}
            if unsafe({**row, 'payload': candidate}): value = candidate
        for key in list(value):
            if isinstance(value[key], str): value[key] = ddmin(value[key], lambda s: {**row, 'payload': {**value, key:s}})
        row['payload'] = value
    return row

PATHS = ['/', '~', '/etc', '/usr', '/lib32', './cache', './a b', '$HOME', '/home/tester', '/tmp/x', '', '//', '/./', '/a/..']
NUMBERS = ['0', '32', '0x20', '0o40', '0b100000', '3_2', '.5', '1e2', '1j', '0.0', '1e-7']
OPERATORS = ['+', '-', '*', '/', '//', '**', '<<', '>>', '<=', '>=', '==', '!=', '|', '&', '^', ':=']
ESCAPES = ['/', '\\x2f', '\\u002f', '\\057', '\\N{SOLIDUS}', '\\\n/', '\\\r/', '\\r', '\\t']

def grammar(rng, index, benign=False):
    name = 'v' + str(index)
    path = rng.choice(PATHS)
    kind = rng.randrange(12 if benign else 26)
    if benign:
        forms = [
            ('python', f'{name} = {rng.randrange(100000)}\nprint({name})'),
            ('python', f'import math as {name}\n{name}.sqrt({rng.randrange(1000)})'),
            ('python', f'print({json.dumps("note " + str(index))})'),
            ('python', f'{name} = [1, 2, 3]\nprint({name})'),
            ('python', f'if True:\n    print({index})'),
            ('python', f'print(f"item {{{index}}}")'),
            ('python', f'def {name}(x):\n    return x + 1\nprint({name}(2))'),
            ('python', f'import os as {name}\nprint({name}.path.join("a", "b"))'),
            ('node', f'const {name} = {index}; console.log({name});'),
            ('terminal', f'printf "item {index}"'),
            ('mcp__s__note', {'note': f'ordinary record {index}'}),
            ('mcp__s__run', {'command': f'printf "value {index}"', 'note': 'plain record'}),
        ]
        identity, payload = forms[kind]
        return dict(identity=identity, payload=payload)
    if kind == 0: code = f'import shutil as {name}\n{name}.rmtree({path!r})\nx = {rng.choice(NUMBERS)} {rng.choice(OPERATORS)} 2'
    elif kind == 1: code = f'import os as {name}\n{name}.remove({path!r})'
    elif kind == 2: code = f'from shutil import rmtree as {name}\n{name}({path!r})'
    elif kind == 3: code = f'import shutil as {name}\n{rng.choice(["if True:", "while False:"])}\n    {name}.rmtree({path!r})'
    elif kind == 4: code = f'os.remove(f"/lib{{{rng.choice(NUMBERS)}}}")\n# {index}'
    elif kind == 5: code = f'os.remove("{rng.choice(ESCAPES)}")\n# {index}'
    elif kind == 6: code = rng.choice(['#note\r', '#note\r\n', '#note\n', '']) + f'os.remove({path!r})\n# {index}'
    elif kind == 7:
        program = rng.choice(['rm', 'r\\\\m', 'r\\\nm', 'r\\\rm', 'printf'])
        code = f'os.system("{program} {path}")\n# {index}'
    elif kind == 8: code = f'{name} = {path!r}\nos.remove({name})'
    elif kind == 9: code = f'subprocess.run(["rm", "-rf", {path!r}])\n# {index}'
    elif kind == 10:
        inner = f'os.remove({path!r})'
        for _ in range(rng.randrange(1,7)): inner = f'exec({inner!r})'
        code = inner + f'\n# {index}'
    elif kind == 11: code = f'print({path!r})\n{name} = {rng.choice(NUMBERS)}'
    elif kind == 12: return dict(identity='node', payload=f'const {name}=require("fs"); {name}.rmSync({json.dumps(path)});')
    elif kind == 13: return dict(identity='node', payload=f'const {name}=require("child_process"); {name}.execSync({json.dumps("rm -rf " + path)});')
    elif kind == 14: return dict(identity='terminal', payload=f'{rng.choice(["rm", "unlink", "rmdir", "shred", "printf", "echo"])} {rng.choice(["", "-rf ", "-- "])}{path} # {index}')
    elif kind == 15: return dict(identity='mcp__s__run', payload={'command': rng.choice(['\x1c', '\x85', ' ', '\ufeff']), 'cmd': f'rm {path}', 'note': str(index)})
    elif kind == 16: return dict(identity='mcp__s__note', payload={'note': [f'record {index}', f'rm -rf {path}']})
    elif kind == 17: code = f'if True:\n import shutil as {name}\nimport math as {name}\n{name}.rmtree({path!r})'
    elif kind == 18: code = f'os.remove({rng.choice(["r", "b", "u", "f", "br", "rf"])}"{rng.choice(ESCAPES)}")\n# {index}'
    elif kind == 19: code = f'{name} = {path!r}\nexec("os.remove(" + repr({name}) + ")")'
    elif kind == 20:
        control = rng.choice(['\x00', '\r', '\r\n', '\x1c', '\x85', '\u00a0'])
        code = rng.choice([f'print("{control}")', f'# {control}\nprint({index})', f'os.remove("{control}{path}")', f'{control}print({index})'])
    elif kind == 21:
        literal = rng.choice([repr(path), "b'ÿ'", "f'}'", "b'a' 'b'"])
        separator = rng.choice([' ', '; ', '\n'])
        code = 'import math as os' + separator + f'os.remove({literal})'
    elif kind == 22:
        target = rng.choice(["os.remove('')", name, name+'.x', '['+name+']'])
        code = f'{target} = {rng.choice(["09", "0", "32"])}'
    elif kind == 23:
        code = f'print(x=os.system("rm {path}"), x={index})'
    elif kind == 24:
        parameter = rng.choice(['x', 'x=1', 'x: int', '*x', '**x'])
        code = f'def {name}({parameter}):\n    print({path!r})'
    else:
        indent = rng.choice([' ', '    ', '\t', '\f', ''])
        code = f'if True:\n{indent}import shutil as {name}\nimport math as {name}\n{name}.rmtree({path!r})'
    return dict(identity='python', payload=code)

def mutated(rng, index, corpus):
    row = dict(rng.choice(corpus)); value = row['payload']
    if not isinstance(value, str):
        row['payload'] = {**value, 'note': str(index)} if isinstance(value, dict) else value
        return row
    op = rng.randrange(14)
    if op == 0: value = value.replace('\n', '\r')
    elif op == 1: value = value.replace('\n', '\r\n')
    elif op == 2: value += '\nx = ' + rng.choice(NUMBERS) + ' ' + rng.choice(OPERATORS) + ' 2'
    elif op == 3: value = value.replace('/', rng.choice(ESCAPES))
    elif op == 4:
        at = rng.randrange(len(value)+1); value = value[:at] + rng.choice(['"', "'", '\\', '\r', '\x00', '\t', '\u00a0', ';', '<<']) + value[at:]
    elif op == 5: value = value.replace('os', 'alias').replace('shutil', 'alias'); value = 'import shutil as alias\n' + value
    elif op == 6: value = '(' * rng.randrange(190,210) + value + ')' * rng.randrange(190,210)
    elif op == 7: value += '\nx=' + '9'*rng.choice([4299,4300,4301,5000])
    elif op == 8: value += '\n' + rng.choice(['x=0\n'*140000, ' '*1000000, "'"+'\\'*10000, 'def f('+'a,'*400000+'): pass', 'f(a=0)\n'*80000])
    elif op == 9: value += '\n#' + str(index)
    elif op == 10:
        at = rng.randrange(max(1,len(value))); value = value[:at] + value[at+1:]
    elif op == 11: value = value.replace(';',' ').replace('\n',' ')
    elif op == 12: value = "import math as os " + value
    else: value = value.replace('0','09',1)
    row['payload'] = value
    return row

def main():
    p=argparse.ArgumentParser(); p.add_argument('--inputs', type=int, default=2000000); p.add_argument('--benign', type=int, default=100000); p.add_argument('--seed', type=int, default=130019); p.add_argument('--out', default='evidence/bld3-toolid-s4a/fuzz.json'); a=p.parse_args()
    assert float(pathlib.Path('/proc/loadavg').read_text().split()[0]) < 85
    corpus=[]
    for line in (FIX/'judge_expected.tsv').read_text().splitlines()[1:]:
        rid, identity, mode, payload, *_ = line.split('\t')
        if rid not in json.loads((FIX/'judge_faults.json').read_text()): corpus.append(dict(identity=identity, mode=mode, payload=json.loads(payload)))
    rng=random.Random(a.seed); port=Port(); start=time.time(); digest=hashlib.sha256()
    totals=dict(inputs=0, unsafe=0, benign_inputs=0, benign_overstrict=0, corpus_mutations=0, grammar=0, port_gate_comparisons=0)
    counterexamples=[]
    def check(rows, benign):
        actual=port.batch(rows)
        for row, got in zip(rows,actual,strict=True):
            expected=outcome(row); totals['port_gate_comparisons']+=1
            digest.update(json.dumps(row,sort_keys=True).encode()); digest.update(b'\n')
            if benign:
                assert expected == 'run', ('benign generator non-benign',row,expected)
                totals['benign_inputs']+=1; totals['benign_overstrict']+=got!='run'
            else: totals['inputs']+=1
            if got=='run' and expected!='run':
                totals['unsafe']+=1
                small=minimize(port,row); small['expected']=outcome(small)
                small['id']='R13-FUZZ-'+hashlib.sha256(json.dumps(small,sort_keys=True).encode()).hexdigest()[:16]
                if small['id'] not in {x['id'] for x in counterexamples}:
                    counterexamples.append(small)
                    with (ROOT/'server/testing/fixtures/no-limits-r13-fuzz.jsonl').open('a') as f: f.write(json.dumps(small)+'\n')
                print('COUNTEREXAMPLE',json.dumps(small),flush=True)
        if totals['unsafe']: raise RuntimeError('unsafe witnesses saved; widen the generator after fixing')
    try:
        for benign, count in [(False,a.inputs),(True,a.benign)]:
            batch=[]
            for i in range(count):
                # Resource-edge mutations are deliberately sparse; never replace
                # all grammar coverage with copies of a few large known rows.
                mutate = not benign and i % 101 == 0
                row=mutated(rng,i,corpus) if mutate else grammar(rng,i,benign)
                if not benign: totals['corpus_mutations' if mutate else 'grammar']+=1
                batch.append(row)
                if len(batch)==256: check(batch,benign); batch=[]
                if i and i%100000==0: print(json.dumps(totals),flush=True)
            if batch: check(batch,benign)
    finally:
        port.close(); totals.update(seed=a.seed, elapsed_seconds=round(time.time()-start,3), input_sha256=digest.hexdigest(), oracle_sha256=hashlib.sha256((FIX/'judge.py').read_bytes()).hexdigest(), over_strict_rate=totals['benign_overstrict']/max(1,totals['benign_inputs']), network='none')
        totals['port_sha256'] = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted((ROOT/'server').glob('no-limits-*.ts')) if not path.name.endswith('.test.ts')}
        totals['port_sha256']['server/code-lexer.ts'] = hashlib.sha256((ROOT/'server/code-lexer.ts').read_bytes()).hexdigest()
        totals['port_sha256']['server/python-unicode-names.json'] = hashlib.sha256((ROOT/'server/python-unicode-names.json').read_bytes()).hexdigest()
        totals['port_sha256']['shared/no-limits-decision.ts'] = hashlib.sha256((ROOT/'shared/no-limits-decision.ts').read_bytes()).hexdigest()
        totals['generator_sha256'] = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
        (ROOT/a.out).write_text(json.dumps(totals,indent=2)+'\n'); print(json.dumps(totals),flush=True)
    assert totals['unsafe']==0
    assert totals['over_strict_rate'] < .01
if __name__=='__main__': main()
