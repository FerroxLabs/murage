import os,sys,time,json,pathlib,subprocess,hashlib,urllib.request,tarfile,shutil,signal,re,zipfile
S=pathlib.Path(__file__).resolve().parents[2]
ARCH=os.uname().machine
if sys.platform!="darwin" or ARCH not in ("arm64","x86_64"):raise RuntimeError("native darwin arm64 or x86_64 runner required")
translated=subprocess.run(["/usr/sbin/sysctl","-in","sysctl.proc_translated"],capture_output=True,text=True)
if translated.stdout.strip()=="1":raise RuntimeError("Rosetta translation is not a native build target")
TARGET="darwin-arm64" if ARCH=="arm64" else "darwin-x64"
if len(sys.argv)!=3:raise RuntimeError("Usage: build-mac.py ABSOLUTE_NEW_BUILD_ROOT ABSOLUTE_CI_KEYCHAIN")
R=pathlib.Path(sys.argv[1]); KEYCHAIN=pathlib.Path(sys.argv[2])
if not R.is_absolute() or R.exists() or not KEYCHAIN.is_absolute() or not KEYCHAIN.is_file():raise RuntimeError("fresh build root and existing CI keychain required")
R.mkdir(mode=0o700)
source_sha=os.environ.get("SOURCE_SHA","")
if not re.fullmatch(r"[0-9a-f]{40}",source_sha) or subprocess.check_output(["git","rev-parse","HEAD"],cwd=S,text=True).strip()!=source_sha:raise RuntimeError("exact source SHA required")
subprocess.run(["git","diff","--exit-code",source_sha,"--","native/gepa"],cwd=S,check=True)
NODE=shutil.which('node')
if not NODE:raise RuntimeError('Node required')
began=time.monotonic(); deadline=began+2700
active_process=None
def deadline_expired(_signum,_frame): raise TimeoutError("45 minute cap reached")
signal.signal(signal.SIGALRM,deadline_expired)
signal.alarm(2700)
for d in ("home","cache","tmp","inputs","wheelhouse","source","logs","prefix","work","dist"):(R/d).mkdir(exist_ok=True,mode=0o700)
env={"HOME":str(R/"home"),"PATH":"/usr/bin:/bin:/usr/sbin:/sbin","TMPDIR":str(R/"tmp"),"LC_ALL":"C","PYINSTALLER_CONFIG_DIR":str(R/"cache"),"PIP_CONFIG_FILE":"/dev/null","PIP_DISABLE_PIP_VERSION_CHECK":"1","SDKROOT":subprocess.check_output(["/usr/bin/xcrun","--show-sdk-path"],text=True).strip()}
# Security.framework must see the same disposable runner account that imported
# the explicit task keychain. Keep compiler/package HOME isolated; inherit no
# credential environment when using the runner HOME for signing operations.
runner_home=os.environ.get("HOME","")
runner_temp=os.environ.get("RUNNER_TEMP","")
if os.environ.get("GITHUB_ACTIONS")!="true" or not pathlib.Path(runner_home).is_absolute() or not pathlib.Path(runner_temp).is_absolute() or not KEYCHAIN.resolve().is_relative_to(pathlib.Path(runner_temp).resolve()):raise RuntimeError("signing requires the disposable CI runner and its task keychain")
signing_env={**env,"HOME":runner_home}
identities=subprocess.check_output(["/usr/bin/security","find-identity","-v","-p","codesigning",str(KEYCHAIN)],env=signing_env,text=True)
matches=re.findall(r'([A-Fa-f0-9]{40}) "Developer ID Application: Ferrox Labs, LLC [^"\n]+"',identities)
if len(matches)!=1:raise RuntimeError("one Ferrox Developer ID in task keychain required")
IDENTITY=matches[0]
state={"contract":"One attempt, 45 minute cap, make -j2. Pinned CPython 3.13.15, GEPA 0.1.4, PyInstaller 6.22.3; self-contained native Mac runtime; six offline fixture scenarios; actual licenses and externally verified manifest. CI-only Developer ID from explicit throwaway keychain; sign before manifest. No publication.","target":TARGET,"architecture":ARCH,"round":1,"attempt":1,"supervisorPid":os.getpid(),"root":str(R)}
def receipt(**kw):
 state.update(kw);state["elapsedSeconds"]=round(time.monotonic()-began,2);(R/"state.json").write_text(json.dumps(state,indent=2)+"\n");print(json.dumps(kw),flush=True)
def run(stage,args,cwd=None,command_env=None):
 global active_process
 receipt(stage=stage,command=[str(x) for x in args]); log=open(R/"logs"/(stage+".log"),"wb")
 p=subprocess.Popen([str(x) for x in args],cwd=cwd or R,env=command_env if command_env is not None else env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 active_process=p
 receipt(ownedPid=p.pid,ownedProcessGroup=p.pid)
 try:code=p.wait(timeout=max(0,deadline-time.monotonic()))
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
  raise RuntimeError("45 minute cap reached")
 finally:log.close()
 active_process=None
 receipt(exitCode=code,ownedPid=None,ownedProcessGroup=None)
 if code:raise RuntimeError(stage+" failed with exit "+str(code))
def fetch(url,path,expected=None):
 receipt(stage="download",url=url)
 with urllib.request.urlopen(url,timeout=min(60,max(1,deadline-time.monotonic()))) as src,open(path,"wb") as out:shutil.copyfileobj(src,out)
 h=hashlib.sha256(path.read_bytes()).hexdigest()
 with open(R/"input-hashes.txt","a") as f:f.write(h+"  "+str(path.relative_to(R))+"\n")
 if expected and h!=expected:raise RuntimeError("SHA256 mismatch: "+str(path))
 return path
try:
 receipt(status="RUNNING")
 pins={name:hashlib.sha256((S/"native/gepa"/name).read_bytes()).hexdigest() for name in ["gepa-worker.py","gepa-worker.spec","requirements-build.txt","requirements-runtime.txt","offline-fixture.py"]}
 for name in pins:shutil.copyfile(S/"native/gepa"/name,R/"inputs"/name)
 (R/"source-identity.json").write_text(json.dumps({"head":source_sha,"files":pins},indent=2))
 for label,args in [("uname",["/usr/bin/uname","-a"]),("clang",["/usr/bin/clang","--version"]),("make",["/usr/bin/make","--version"]),("sdk",["/usr/bin/xcrun","--show-sdk-path"]),("disk",["/bin/df","-k","."])]:
  if not pathlib.Path(args[0]).is_file():raise RuntimeError("Required tool unavailable: "+args[0])
  run("toolchain-"+label,args)
 archive=fetch("https://www.python.org/ftp/python/3.13.15/Python-3.13.15.tar.xz",R/"inputs/Python-3.13.15.tar.xz","1e66a7945a48390ee4c2a4268a0e4185884059a13c4aab6d148aa208deea4a76")
 with tarfile.open(archive) as tf:tf.extractall(R/"source",filter="data")
 # Fetch only exact hashed required wheels from official package metadata.
 locks=(R/"inputs/requirements-build.txt").read_text()+"\n"+(R/"inputs/requirements-runtime.txt").read_text()
 locks=locks.replace("\\\n","")
 for line in locks.splitlines():
  m=re.match(r"([a-zA-Z0-9_-]+)==([^ ;]+)",line)
  if not m or "win32" in line:continue
  name,version=m.groups(); permitted=re.findall(r"sha256:([0-9a-f]{64})",line)
  meta=fetch("https://pypi.org/pypi/"+name+"/"+version+"/json",R/"inputs"/(name+"-metadata.json"))
  choices=[v for v in json.loads(meta.read_text())["urls"] if v["filename"].endswith(".whl") and v["digests"]["sha256"] in permitted and (v["filename"].endswith("none-any.whl") or "macosx" in v["filename"] and ("universal2" in v["filename"] or ARCH in v["filename"]))]
  if len(choices)!=1:raise RuntimeError("Expected one pinned compatible wheel: "+name)
  v=choices[0];fetch(v["url"],R/"wheelhouse"/v["filename"],v["digests"]["sha256"])
 src=R/"source/Python-3.13.15"
 run("configure",[src/"configure","--prefix="+str(R/"prefix"),"--enable-shared","--with-ensurepip=install"],src)
 run("compile",["/usr/bin/make","-j2"],src)
 run("install",["/usr/bin/make","-j2","install"],src)
 py=R/"prefix/bin/python3.13"
 run("runtime-identity",[py,"-I","-c","import sys,platform,sysconfig;print(sys.version);print(platform.machine());print(sysconfig.get_config_vars());assert sys.version_info[:3]==(3,13,15);assert platform.machine()=="+repr(ARCH)+";assert not sysconfig.get_config_var('Py_GIL_DISABLED')"])
 run("venv",[py,"-I","-m","venv",R/"venv"])
 py=R/"venv/bin/python"
 run("wheel-install",[py,"-I","-m","pip","install","--no-index","--find-links",R/"wheelhouse","--only-binary=:all:","--require-hashes","-r",R/"inputs/requirements-build.txt"])
 run("package",[py,"-I","-m","PyInstaller","--clean","--noconfirm","--distpath",R/"dist","--workpath",R/"work",R/"inputs/gepa-worker.spec"])
 bundle=R/"dist/gepa-worker"
 licenses=bundle/"licenses";licenses.mkdir(mode=0o755)
 python_license=src/"LICENSE"
 if not python_license.is_file() or not python_license.stat().st_size:raise RuntimeError("Python source license missing")
 shutil.copyfile(python_license,licenses/"Python-LICENSE.txt")
 notices=[];gepa_license=None
 for wheel in sorted((R/"wheelhouse").glob("*.whl")):
  with zipfile.ZipFile(wheel) as z:
   names=[name for name in z.namelist() if ".dist-info/" in name and pathlib.PurePosixPath(name).name.lower().startswith(("license","copying","notice")) and not name.endswith("/")]
   if not names:raise RuntimeError("Wheel license unavailable: "+wheel.name)
   for name in names:
    raw=z.read(name)
    if not raw.strip():raise RuntimeError("Empty wheel license: "+wheel.name)
    text=raw.decode("utf-8")
    notices.append("\n===== "+wheel.name+" / "+name+" =====\n"+text)
    if wheel.name.startswith("gepa-0.1.4-") and pathlib.PurePosixPath(name).name.lower().startswith("license"):gepa_license=text
 if not gepa_license:raise RuntimeError("GEPA wheel license missing")
 (licenses/"GEPA-LICENSE.txt").write_text(gepa_license)
 for license_file in sorted(src.glob("Modules/**/LICENSE*")):
  if license_file.is_file():notices.append("\n===== CPython source / "+str(license_file.relative_to(src))+" =====\n"+license_file.read_text())
 (licenses/"THIRD-PARTY-NOTICES.txt").write_text("Actual license notices from pinned input wheels and CPython source.\n"+"\n".join(notices))
 # Record unsigned inventory before applying the existing CI Developer ID.
 native=[]
 for path in sorted(bundle.rglob("*"),key=lambda p:len(p.parts),reverse=True):
  if path.is_symlink() or not path.is_file():continue
  with path.open("rb") as f:magic=f.read(4)
  if magic in [bytes.fromhex("cffaedfe"),bytes.fromhex("feedfacf"),bytes.fromhex("cafebabe"),bytes.fromhex("bebafeca")]:native.append(path)
 if not native:raise RuntimeError("No native runtime files found")
 unsigned={str(f.relative_to(bundle)):hashlib.sha256(f.read_bytes()).hexdigest() for f in native}
 (R/"unsigned-native.json").write_text(json.dumps(unsigned,indent=2))
 for index,path in enumerate(native):
  archs=subprocess.check_output(["/usr/bin/lipo","-archs",str(path)],env=env,text=True).split()
  if ARCH not in archs:raise RuntimeError("Native file lacks "+ARCH+": "+str(path.relative_to(bundle)))
  libraries=subprocess.check_output(["/usr/bin/otool","-L",str(path)],env=env,text=True).splitlines()[1:]
  for library in libraries:
   name=library.strip().split(" (",1)[0]
   if not name.startswith(("@loader_path/","@rpath/","@executable_path/","/usr/lib/","/System/Library/")):raise RuntimeError("Non-portable native dependency: "+str(path.relative_to(bundle)))
  run("sign-"+str(index),["/usr/bin/codesign","--force","--sign",IDENTITY,"--keychain",KEYCHAIN,"--timestamp","--options","runtime",path],command_env=signing_env)
  run("verify-sign-"+str(index),["/usr/bin/codesign","--verify","--strict","--verbose=2",path],command_env=signing_env)
 run("signed-offline-fixture",[py,"-I",R/"inputs/offline-fixture.py","--",bundle/"gepa-worker"])
 destination=S/"dist-native/gepa"/TARGET
 if destination.exists():raise RuntimeError("GEPA stage already exists")
 destination.parent.mkdir(parents=True,exist_ok=True)
 shutil.copytree(bundle,destination,symlinks=True)
 metadata=S/"qualification-evidence/gepa-package-metadata.json"
 run("manifest",[NODE,S/"native/gepa/create-manifest.mjs",destination,TARGET,metadata])
 receipt(status="BUILT_SIGNED_STAGED",bundle=str(destination),metadataReceipt=str(metadata),sourceSha=source_sha,nativeFiles=len(native))
except BaseException as e:
 signal.alarm(0)
 if active_process is not None and active_process.poll() is None:
  try:os.killpg(active_process.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:active_process.wait(timeout=5)
  except subprocess.TimeoutExpired:
   try:os.killpg(active_process.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   active_process.wait()
 receipt(status="BLOCKED",error=repr(e),ownedPid=None,ownedProcessGroup=None);sys.exit(1)
finally:signal.alarm(0)
