# Execute the byte-identical reference without modifying its expectations.
import importlib.util, json, pathlib, sys
root = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location('reference', root / 'hermes_fsm.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for line in (root / 'hermes_traces.jsonl').read_text().splitlines():
    trace = json.loads(line)
    result = module.run_codex(trace) if trace.get('engine') == 'codex' else module.run_trace(trace)
    print(json.dumps({'id': trace['id'], 'outcome': result}, ensure_ascii=False))
