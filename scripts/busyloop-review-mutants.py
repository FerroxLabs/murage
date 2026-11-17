"""Behavioral removal mutants at each customer failure boundary; container-only."""
import json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'evidence/cfix-busyA22/mutants';out.mkdir(parents=True,exist_ok=True)
chat='server/drivers/openai-chat.ts'
mutants={
 'cli_envelope_bypass':('server/drivers/cli-flux-budget.ts','const wire = cliRefusal(registerBusyloopPayloadSite("classify", error));',"const wire = {decision:{reason:'other',action:'PASS',wait:'-'},status:0,body:{}};"),
 'codex_retry_guard_bypass':('server/drivers/codex.ts','const decision = providerError?.fluxDecision;','const decision = undefined;'),
 'headless_frame_bypass':('server/memory/pip-transport.ts','    observe?.(line);','    void line;'),
 'sse_bypass':(chat,'const decision = fluxResponse.decision ? fluxResponseDecision(registerBusyloopPayloadSite("classify", {status: response.status, headers: response.headers, body: chunk})) : undefined;','const decision: Decision | undefined = undefined;'),
 'truncate_before_structure':('server/drivers/flux-busyloop-readers.ts','({rawBody, bytes} = await readFluxJson(response, signal, !response.ok));','rawBody = (await response.text()).slice(0, 64000);'),
 'acp_result_bypass':('server/drivers/acp/core.ts','const resultDecision = fluxRoutedTurn ? acpRefusal(registerBusyloopPayloadSite("classify", result)) : undefined;','const resultDecision: Decision | undefined = undefined;'),
 'text_only_bypass':('server/drivers/http-text-only.ts','const fluxResponse = await inspectFluxResponse(response, toFlux, signal, true);','const fluxResponse: Awaited<ReturnType<typeof inspectFluxResponse>> = {};'),
 'duplicate_header_loss':('shared/flux-busyloop.ts',"h['x-flux-hold-reason'].split(',').map(s => s.trim())", "[h['x-flux-hold-reason']]"),
 'tool_bypasses_backoff':(chat,'if (decision && decision.action !== "PASS") throw new ProviderHttpError(response.status, body, label, true, fluxCode, decision);','if (isTerminal(decision)) throw new ProviderHttpError(response.status, body, label, true, fluxCode, decision);'),
 'compat_retry_off_by_omission':(chat,'if ((decision || options.retryScale !== undefined) && !aborted','if (options.retryScale !== undefined && !aborted'),
}
tests={
 'cli_envelope_bypass':['server/drivers/cli-flux-budget.test.ts'],
 'codex_retry_guard_bypass':['server/drivers/codex.test.ts','-t','nested Flux refusal'],
 'headless_frame_bypass':['server/drivers/headless-text-only.test.ts','-t','terminal headless Flux'],
}
results=[]
for name,(file,old,new) in mutants.items():
 path=root/file; original=path.read_bytes();source=original.decode()
 assert source.count(old)==1,(name,source.count(old))
 try:
  path.write_text(source.replace(old,new,1))
  with (out/(name+'.log')).open('w') as log:
   run=subprocess.run(['node_modules/.bin/vitest','run',*tests.get(name,['server/drivers/busyloop-review.test.ts'])],cwd=root,stdout=log,stderr=subprocess.STDOUT)
  killed=run.returncode!=0 and 'AssertionError' in (out/(name+'.log')).read_text()
  results.append([name,'KILLED' if killed else 'SURVIVED/INVALID'])
  print(*results[-1],flush=True)
 finally:
  path.write_bytes(original)
  assert path.read_bytes()==original
(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
assert all(r[1]=='KILLED' for r in results)
