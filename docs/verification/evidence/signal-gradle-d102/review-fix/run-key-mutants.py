"""Execute regressions against isolated key-retriever mutants; no live inputs."""
import importlib.util, io, pathlib, sys, unittest
sys.dont_write_bytecode=True
repo=pathlib.Path('/repo'); out=pathlib.Path('/evidence')
spec=importlib.util.spec_from_file_location('regression',repo/'scripts/signal-gradle-verification.test.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
source=module.RETRIEVER.read_text()
mutants={
    'truncation': source.replace('data=res.read(max_key_bytes+1)', 'data=res.read(max_key_bytes)'),
    'swallowed-local-errors': source.replace(
        "        dest=out/(key+'.asc'); dest.write_bytes(data)\n        run_gpg(['--import',str(dest)])",
        "        try:\n            dest=out/(key+'.asc'); dest.write_bytes(data)\n            run_gpg(['--import',str(dest)])\n        except Exception:\n            return key+' unavailable; SHA256 required'"),
}
for name,mutant in mutants.items():
    assert mutant!=source
    module.RETRIEVER=out/('mutant-'+name+'.py'); module.RETRIEVER.write_text(mutant)
    log=io.StringIO()
    result=unittest.TextTestRunner(stream=log,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(module.KeyRetrieval))
    (out/(name+'-mutant.log')).write_text(log.getvalue())
    print(name+':\n'+log.getvalue())
    assert not result.wasSuccessful(), 'SURVIVED '+name
    assert not result.errors, 'Mutation must fail an assertion, not test infrastructure'
    print('KILLED: '+name)
