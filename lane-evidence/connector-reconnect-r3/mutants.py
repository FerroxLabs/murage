from pathlib import Path
import subprocess,json,hashlib,difflib
E=Path('lane-evidence/connector-reconnect-r3')
C='server/composio.ts';H='server/connected-app-health.ts';S='server/connector-health-store.ts';N='shared/connected-app-calls.ts';I='server/index.ts'
P='server/connector-reconnect-r3-preflight.test.ts';A='server/connector-reconnect-r3-attribution.test.ts';R='server/connected-app-health.test.ts';T='server/connector-reconnect-r3-schedule.test.ts'
mutants=[
('M1a',C,'  let read: InventoryRead | undefined;','  if (outcome === "transport") return "unknown";\n  let read: InventoryRead | undefined;',P,'R1a|R1h'),
('M1b',C,'try { read = await postProbeInventory(cfg, owner); }','try { void postProbeInventory(cfg, owner).catch(() => {}); }',P,'R1h'),
('M1c',C,'if (!read?.services || read.revalidating) return unknown();','if (!read?.services || read.revalidating) { clearAccount(owner, slug, account.id); return "healthy"; }',P,'R1f'),
('M1d',C,'if (outcome === "ok") { clearAccount','if (outcome === "ok" || outcome === "toolError") { clearAccount',P,'R1d'),
('M1e',C,'const unknown = () => { connectorHealthStore()','const unknown = () => { clearAccount(owner, slug, account.id); connectorHealthStore()',P,'R1 unknown'),
('M2a',C,'  const call = normalizedCallRows(request.params?.name ?? "", request.params?.arguments);','  const raw = request.params?.arguments as {tools?: Array<{tool_slug:string;account?:string}>};\n  const call = {complete:true,rows:(raw?.tools ?? []).map((row,index)=>({index,tool:row.tool_slug,account:row.account}))};',A,'R2a'),
('M2b',C,'call.rows.length > 1 ? row.index : undefined','call.rows.length > 1 && call.rows.some((r,i) => call.rows.some((other,j) => i !== j && r.tool.split("_")[0] === other.tool.split("_")[0] && r.account !== other.account)) ? row.index : undefined',A,'R2 unattributed batch mixed'),
('M2c',C,'  const outcomes = new Map<string,','  if (call.rows.length > 1) { const whole = readAppAnswer(call.rows.map(r=>r.tool), request.id, bytes); for (const [slug,cause] of whole.failed) noteNeedsReconnect(cfg,slug,cause,[]); }\n  const outcomes = new Map<string,',A,'R2 unattributed batch same'),
('M2d',N,'entry(call.target, call.body ?? {}, 0)','entry(call.target, {}, 0)',A,'R2b'),
('M3a',H,'  const error = (slug: string, status: number | null) => {','  const error = (slug: string, status: number | null) => {\n    const match = /\\b(401|403)\\b/.exec(new TextDecoder().decode(bytes)); if (match) status = Number(match[1]);',R,'R3a|R3b'),
('M3b',H,'["status", "status_code", "statusCode", "http_status"]','["status", "status_code", "statusCode", "http_status", "code"]',R,'R3g'),
('M3c',H,'    if (row.kind === "auth" || obj(row.error)?.kind === "auth") return true;','    // mutant: ignore parsed content broker auth',R,'R3e'),
('M3d',H,'/^[1-5][0-9]{2}$/.test(value)) return Number(value)','/^[1-5][0-9]{2}/.test(value)) return Number.parseInt(value)',R,'R3d|R3g'),
('M4a',I,'      if (toolkits.length) await composio.checkIdleConnectorHealth(cfg, toolkits);','      await composio.checkIdleConnectorHealth(cfg);',T,'R4a'),
('M4b',S,'routine.nextRunAt - now <= PREFLIGHT_LOOKAHEAD_MS','true',T,'R4b'),
('M4c',S,'routine.enabled && routine.nextRunAt !== null','routine.nextRunAt !== null',T,'R4b'),
('M3-row',H,'return !!result && slugOfRow(result) !== null && rowBrokerAuth(result);','return false;',P,'R3e row-level'),
]
original={f:Path(f).read_text() for f in [C,H,S,N,I]}
results=[]
try:
 for name,file,before,after,test,pattern in mutants:
  assert original[file].count(before)==1,(name,original[file].count(before))
  mutated=original[file].replace(before,after)
  Path(file).write_text(mutated)
  patch=''.join(difflib.unified_diff(original[file].splitlines(True),mutated.splitlines(True),fromfile=file,tofile=file))
  (E/(name+'.patch')).write_text(patch)
  command=['node_modules/.bin/vitest','run',test,'-t',pattern,'--reporter=verbose']
  with (E/(name+'.log')).open('w') as log:
   result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT)
  Path(file).write_text(original[file])
  output=(E/(name+'.log')).read_text()
  killed=result.returncode!=0 and ('AssertionError:' in output or 'expected ' in output) and 'Unhandled Error' not in output and 'Transform failed' not in output and 'TypeError:' not in output
  results.append(dict(mutant=name,file=file,command=command,log=str(E/(name+'.log')),patch=str(E/(name+'.patch')),exit=result.returncode,killed_by_assertion=killed))
  (E/'mutants.json').write_text(json.dumps(results,indent=2)+'\n')
  print(name,'KILLED' if killed else 'OPEN',flush=True)
finally:
 for file,content in original.items():Path(file).write_text(content)
 (E/'mutant-source-sha256.json').write_text(json.dumps({f:hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in original},indent=2)+'\n')
assert len(results)==len(mutants) and all(row['killed_by_assertion'] for row in results)
