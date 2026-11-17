"""Run mutations in a disposable source copy, never in the validating checkout."""
import os,pathlib,shutil,subprocess,tempfile
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'evidence/cfix-busyA22'
with tempfile.TemporaryDirectory(prefix='busyloop-mutants-') as temp:
 work=pathlib.Path(temp)/'work'
 shutil.copytree(root,work,ignore=shutil.ignore_patterns('.git','node_modules','evidence','__pycache__','dist','dist-server','build','.ijfw','.planning','test-results'),symlinks=True)
 (work/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
 checks=[]
 checks.append(subprocess.run(['python3','scripts/busyloop-review-mutants.py'],cwd=work).returncode)
 env=dict(os.environ,BUSYLOOP_MUTANTS='swap_text_transient,drop_401,credit_unresolved_retry,drop_d12',PYTHONDONTWRITEBYTECODE='1')
 checks.append(subprocess.run(['python3','scripts/busyloop-mutants.py'],cwd=work,env=env).returncode)
 shutil.copytree(work/'evidence/cfix-busyA22/mutants',out/'mutants',dirs_exist_ok=True)
 shutil.copytree(work/'evidence/busyloop-a21/mutants',out/'spec-mutants',dirs_exist_ok=True)
 assert checks==[0,0],checks
 print('10 boundary mutants + 4 required port mutants KILLED; disposable source removed')
