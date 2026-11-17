"""Run the checked-in contract against the review's commented-copy mutant."""
from pathlib import Path
import shutil, subprocess, sys
repo=Path('/repo'); out=Path('/evidence'); label=sys.argv[1]
root=out/('wiring-gate-'+label)
(root/'scripts').mkdir(parents=True)
(root/'gradle').mkdir()
for name in ['node_modules','server']:
    (root/name).symlink_to(repo/name, target_is_directory=True)
for name in ['verification-metadata.xml','verification-keyring.keys']:
    shutil.copyfile(repo/'gradle'/name,root/'gradle'/name)
for name in ['signal-builder.json','signal-gradle-verification.test.py']:
    shutil.copyfile(repo/'scripts'/name,root/'scripts'/name)
contract=Path(sys.argv[2]) if len(sys.argv)>2 else repo/'scripts/signal-runtime-contract.checks.mjs'
shutil.copyfile(contract,root/'scripts/contract.test.mjs')
retriever=Path('docs/verification/evidence/signal-gradle-d102/enrich-keys.py')
(root/retriever).parent.mkdir(parents=True)
shutil.copyfile(repo/retriever,root/retriever)
copy='  cp "$root/gradle/verification-metadata.xml" "$root/gradle/verification-keyring.keys" "$work/source/gradle/"'
source=(repo/'scripts/build-signal-runtime-inputs.sh').read_text()
assert source.count(copy)==1
(root/'scripts/build-signal-runtime-inputs.sh').write_text(source.replace(copy,'  #'+copy.strip()))
(root/'test.config.mjs').write_text("export default {test:{include:['scripts/contract.test.mjs'],environment:'node'}};")
args=['node','/repo/node_modules/vitest/vitest.mjs','run','--config','test.config.mjs','--configLoader','runner','-t','T-GRADLE-STRICT','--maxWorkers','1','--no-file-parallelism','--no-cache']
result=subprocess.run(args,cwd=root,text=True,capture_output=True)
(out/(label+'-wiring-gate.log')).write_text(result.stdout+result.stderr)
print(result.stdout+result.stderr)
print('Underlying gate exit:',result.returncode)
assert result.returncode!=0, 'RED: production wiring gate accepted the commented metadata-copy command'
assert 'missing staged verification-metadata.xml' in result.stdout+result.stderr
print('KILLED: production wiring gate rejected the commented metadata-copy command')
