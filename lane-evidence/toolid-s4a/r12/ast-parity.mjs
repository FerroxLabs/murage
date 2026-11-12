import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { judge } from '../../../server/no-limits-code.ts';
import { readPython } from '../../../server/no-limits-python.ts';
const spec = 'server/testing/fixtures/no-limits-r12/judge.py';
if (createHash('sha256').update(readFileSync(spec)).digest('hex') !== '44f446c91587df3a7caed8c6f1c93560d3a47408e45c223d5f98e369e1f407b1') throw Error('reference changed');
const oracle = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', `
import importlib.util,sys,json
s=importlib.util.spec_from_file_location('reference',sys.argv[1]);m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)
out=[]
for line in open(sys.argv[2]).read().splitlines()[1:]:
 id,identity,mode,raw,expected,reason=line.split('\\t');payload=json.loads(raw)
 row=dict(id=id,identity=identity,mode=mode,payload=payload,twins=m.judge(identity,payload,mode).twins)
 if identity in ('execute_code','python'):
  try:r=m.PyReader(payload).run();tw,lits=r.twins,r.literals
  except (SyntaxError,ValueError,RecursionError):tw,lits=m.py_lexical_fallback(payload)
  row.update(pyTwins=tw,literals=lits)
 out.append(row)
print(json.dumps(out))
`, spec, 'server/testing/fixtures/no-limits-r12/judge_expected.tsv'], { encoding: 'utf8', maxBuffer: 8_000_000 }));
let twins = 0, ast = 0, bad = 0;
for (const r of oracle) {
 const actual = judge(r.identity,r.payload,r.mode).twins;
 twins++;
 if (!isDeepStrictEqual(actual,r.twins)) { bad++; console.log('TWIN MISMATCH',r.id,JSON.stringify({actual,expected:r.twins})); }
 if (r.pyTwins) {
  ast++; const py = readPython(r.payload);
  if (!isDeepStrictEqual(py.twins,r.pyTwins) || !isDeepStrictEqual([...py.literals].sort(),r.literals.sort())) { bad++; console.log('AST MISMATCH',r.id,JSON.stringify({actual:{twins:py.twins,literals:py.literals},expected:{twins:r.pyTwins,literals:r.literals}})); }
 }
}
console.log(JSON.stringify({corpusTwins:twins,pythonAst:ast,mismatches:bad}));
process.exitCode = bad ? 1 : 0;
