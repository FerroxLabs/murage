"""Read trace/projection inputs directly from the pinned executable spec."""
import importlib.util,json,pathlib
p=pathlib.Path(__file__).resolve().parent.parent/'__fixtures__/flux-refusals/spec/busyloop_spec.py'
s=importlib.util.spec_from_file_location('spec',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(dict(traces=m.WITNESS_TRACES, projection=m.PROJECTION_REQUIRED)))
