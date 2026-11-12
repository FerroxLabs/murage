"""ADD-only review witnesses; verdicts are calculated by the immutable A2.2 spec."""
import importlib.util, json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
folder = root / 'server/__fixtures__/flux-refusals/review-a22'
folder.mkdir(exist_ok=True)
p = root / 'server/__fixtures__/flux-refusals/spec/busyloop_spec.py'
s = importlib.util.spec_from_file_location('spec', p); spec = importlib.util.module_from_spec(s); s.loader.exec_module(spec)
rows = []
def add(id, transport, status, body, headers=None, upstream=None, canonical=None):
    value = dict(transport=transport, status=status, headers=headers or {}, body=body)
    if upstream: value['upstream'] = upstream
    endpoint = 'resp' if transport == 'acp' else 'chat'
    verdict = spec.classify(endpoint, status, canonical or headers or {}, body)
    file = folder / (id + '.json')
    content = json.dumps(value, ensure_ascii=True) + '\n'
    if file.exists(): assert file.read_text() == content, id
    else: file.write_text(content)
    rows.append('\t'.join([id, endpoint, *map(str, verdict)]))
add('P1-sse', 'sse', 200, {'error': {'code':'key_revoked','message':'Rate limit'}})
add('P1-long', 'chat', 429, {'error': {'state':'key_revoked','message':'x'*64000}}, {'Retry-After':'1'})
add('P1-long-tail', 'chat', 429, {'error': {'message':'x'*128000,'state':'key_revoked'}}, {'Retry-After':'1'})
add('P1-acp-result', 'acp', 429, {'error': {'state':'key_revoked','message':'Refused'}}, upstream={'http_status':429,'state':'key_revoked'})
add('P2-text-401', 'text', 401, None)
add('P2-text-revoked', 'text', 429, {'error':{'state':'key_revoked'}})
add('P2-duplicate', 'chat', 429, {}, {'Retry-After':'1','X-Flux-Hold-Reason':'key_revoked','x-flux-hold-reason':'key_revoked'})
# Combined wire headers project to the same terminal signal in the reference dictionary interface.
add('P2-conflicting', 'chat', 429, {}, {'Retry-After':'1','X-Flux-Hold-Reason':'concurrency, key_revoked'}, canonical={'retry-after':'1','x-flux-hold-reason':'key_revoked'})
add('P2-tool', 'chat', 400, {'error':{'code':'tool_use_failed','state':'batch_rate','retry_after':60}})
add('P2-compat', 'compat', 429, {'error':{'state':'concurrency','retry_after':2}})
for code in ['key_budget_reached','free_tier_exhausted']:
    for held in [False, True]:
        add('budget-'+code+('-header' if held else '-bare'), 'chat', 402, {'error':{'state':code}}, {'X-Flux-Hold-Reason':code} if held else {})
file = folder / 'expected.tsv'
content = 'id\tendpoint\treason\taction\twait\n' + '\n'.join(rows)+'\n'
if file.exists(): assert file.read_text() == content
else: file.write_text(content)
print('Added/verified',len(rows),'review rows from A2.2')
