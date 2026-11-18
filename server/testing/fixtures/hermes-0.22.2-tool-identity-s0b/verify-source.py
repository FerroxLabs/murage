"""Check prepared public source/runtime inputs inside the offline container."""
import hashlib
import json
from pathlib import Path
import tarfile

HERE = Path(__file__).resolve().parent
RUNTIME = Path('/work/.s0b-runtime')
S0 = json.loads((HERE.parent / 'hermes-0.22.2-tool-identity/PROVENANCE.json').read_text())
archive = RUNTIME / 'hermes-source.tar.gz'
assert hashlib.sha256(archive.read_bytes()).hexdigest() == S0['source']['archive_sha256']
count = 0
py_count = 0
with tarfile.open(archive) as tar:
    for member in tar:
        if not member.isfile():
            continue
        actual = RUNTIME / member.name
        assert actual.read_bytes() == tar.extractfile(member).read(), member.name
        count += 1
        py_count += member.name.endswith('.py')
runtime = json.loads((HERE / 'runtime.json').read_text())
assert runtime['python_sha256'] == S0['binary']['python_executable_sha256']
assert runtime['cli_entry_sha256'] == S0['binary']['entrypoint_sha256']
assert runtime['node_sha256'] == S0['binary']['node_sha256']
assert json.loads((HERE / 'installed-packages.json').read_text()) == json.loads(
    (HERE.parent / 'hermes-0.22.2-tool-identity/installed-packages.json').read_text())
result = {'archive_sha256': S0['source']['archive_sha256'], 'unmodified_files': count,
          'unmodified_python_files': py_count, 'same_python_node_cli_hashes_as_S0': True,
          'same_dependency_versions_as_S0': True, 'gate_box_equivalence': 'not established'}
(HERE / 'source-check.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result))
