"""Build the pinned GEPA runtime on the supported Ubuntu baseline, without publishing."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

SOURCE = Path(__file__).resolve().parents[2]
if sys.platform != "linux" or platform.machine() != "x86_64":
    raise RuntimeError("Native Linux x86_64 runner required")
release = platform.freedesktop_os_release()
if release.get("ID") != "ubuntu" or release.get("VERSION_ID") != "24.04":
    raise RuntimeError("Supported build baseline is Ubuntu 24.04")
if len(sys.argv) != 2:
    raise RuntimeError("Usage: build-linux.py ABSOLUTE_NEW_BUILD_ROOT")
ROOT = Path(sys.argv[1])
DESTINATION = SOURCE / "dist-native/gepa/linux-x64"
if not ROOT.is_absolute() or ROOT.exists() or DESTINATION.exists():
    raise RuntimeError("Fresh absolute build root and absent destination required")
source_sha = os.environ.get("SOURCE_SHA", "")
head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SOURCE, text=True).strip()
if len(source_sha) != 40 or source_sha != head:
    raise RuntimeError("Exact SOURCE_SHA required")
subprocess.run(["git", "diff", "--exit-code", head, "--", "native/gepa"], cwd=SOURCE, check=True)
NODE = shutil.which("node")
if not NODE:
    raise RuntimeError("Node required")
ROOT.mkdir(mode=0o700)
for name in ("home", "tmp", "cache", "inputs", "source", "logs", "wheelhouse", "prefix", "dist", "work"):
    (ROOT / name).mkdir(mode=0o700)
env = {"HOME": str(ROOT / "home"), "PATH": "/usr/bin:/bin", "TMPDIR": str(ROOT / "tmp"),
       "LC_ALL": "C.UTF-8", "PYINSTALLER_CONFIG_DIR": str(ROOT / "cache"),
       "PIP_CONFIG_FILE": "/dev/null", "PIP_DISABLE_PIP_VERSION_CHECK": "1"}
started = time.monotonic()
deadline = started + 2700
active = None
state = {"sourceSha": source_sha, "baseline": release, "architecture": platform.machine(),
         "attempt": 1, "maxSeconds": 2700, "publication": "none"}


def receipt(**values):
    state.update(values)
    state["elapsedSeconds"] = round(time.monotonic() - started, 2)
    (ROOT / "state.json").write_text(json.dumps(state, indent=2) + "\n")


def run(stage, args, cwd=None):
    global active
    receipt(stage=stage)
    with (ROOT / "logs" / (stage + ".log")).open("wb") as log:
        active = subprocess.Popen([str(a) for a in args], cwd=cwd or ROOT, env=env,
                                  stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        receipt(ownedPid=active.pid)
        code = active.wait(timeout=max(0, deadline - time.monotonic()))
    active = None
    receipt(exitCode=code, ownedPid=None)
    if code:
        raise RuntimeError(stage + " failed; inspect retained stage log")


def expire(_signum, _frame):
    raise TimeoutError("45-minute producer limit reached")


signal.signal(signal.SIGALRM, expire)
signal.alarm(2700)
try:
    receipt(status="RUNNING")
    names = ["gepa-worker.py", "gepa-worker.spec", "requirements-build.txt", "requirements-runtime.txt", "offline-fixture.py"]
    hashes = {}
    for name in names:
        original = SOURCE / "native/gepa" / name
        hashes[name] = hashlib.sha256(original.read_bytes()).hexdigest()
        shutil.copyfile(original, ROOT / "inputs" / name)
    receipt(inputs=hashes, glibc=platform.libc_ver())
    run("toolchain", ["gcc", "--version"])
    archive = ROOT / "inputs/Python-3.13.15.tar.xz"
    with urllib.request.urlopen("https://www.python.org/ftp/python/3.13.15/Python-3.13.15.tar.xz", timeout=60) as src, archive.open("wb") as out:
        shutil.copyfileobj(src, out)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != "1e66a7945a48390ee4c2a4268a0e4185884059a13c4aab6d148aa208deea4a76":
        raise RuntimeError("CPython source hash mismatch")
    receipt(pythonSourceSha256=digest)
    with tarfile.open(archive) as tar:
        tar.extractall(ROOT / "source", filter="data")
    src = ROOT / "source/Python-3.13.15"
    # A build-only loader path permits the shared interpreter to run before bundling.
    env["LD_LIBRARY_PATH"] = str(ROOT / "prefix/lib")
    run("configure", [src / "configure", "--prefix=" + str(ROOT / "prefix"), "--enable-shared", "--with-ensurepip=install"], src)
    run("compile", ["make", "-j2"], src)
    run("install", ["make", "-j2", "install"], src)
    python = ROOT / "prefix/bin/python3.13"
    run("runtime-identity", [python, "-I", "-c", "import sys,platform,sysconfig,ssl,sqlite3,bz2,lzma,ctypes; print(sys.version); print(platform.libc_ver()); assert sys.version_info[:3]==(3,13,15); assert platform.machine()=='x86_64'; assert not sysconfig.get_config_var('Py_GIL_DISABLED')"])
    run("venv", [python, "-I", "-m", "venv", ROOT / "venv"])
    python = ROOT / "venv/bin/python"
    run("download-wheels", [python, "-I", "-m", "pip", "download", "--index-url", "https://pypi.org/simple", "--only-binary=:all:", "--require-hashes", "-r", ROOT / "inputs/requirements-build.txt", "--dest", ROOT / "wheelhouse"])
    run("install-wheels", [python, "-I", "-m", "pip", "install", "--no-index", "--find-links", ROOT / "wheelhouse", "--only-binary=:all:", "--require-hashes", "-r", ROOT / "inputs/requirements-build.txt"])
    run("package", [python, "-I", "-m", "PyInstaller", "--clean", "--noconfirm", "--distpath", ROOT / "dist", "--workpath", ROOT / "work", ROOT / "inputs/gepa-worker.spec"])
    bundle = ROOT / "dist/gepa-worker"
    licenses = bundle / "licenses"
    licenses.mkdir()
    shutil.copyfile(src / "LICENSE", licenses / "Python-LICENSE.txt")
    notices = []
    for wheel in sorted((ROOT / "wheelhouse").glob("*.whl")):
        with zipfile.ZipFile(wheel) as z:
            entries = [n for n in z.namelist() if ".dist-info/" in n and Path(n).name.lower().startswith(("license", "copying", "notice")) and not n.endswith("/")]
            if not entries:
                raise RuntimeError("Missing wheel license: " + wheel.name)
            for entry in entries:
                content = z.read(entry)
                if not content.strip():
                    raise RuntimeError("Empty wheel license")
                notices.append(wheel.name + " / " + entry + "\n" + content.decode("utf-8"))
                if wheel.name.startswith("gepa-0.1.4-") and Path(entry).name.lower().startswith("license"):
                    (licenses / "GEPA-LICENSE.txt").write_bytes(content)
    for license_file in sorted(src.glob("Modules/**/LICENSE*")):
        if license_file.is_file():
            notices.append(str(license_file.relative_to(src)) + "\n" + license_file.read_text())
    (licenses / "THIRD-PARTY-NOTICES.txt").write_text("\n\n".join(notices))
    if not (licenses / "GEPA-LICENSE.txt").is_file():
        raise RuntimeError("GEPA license missing")
    native = []
    for path in sorted(bundle.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as f:
            header = f.read(20)
        if header[:4] != b"\x7fELF":
            continue
        if len(header) < 20 or header[4:6] != b"\x02\x01" or int.from_bytes(header[18:20], "little") != 62:
            raise RuntimeError("Non-x86_64 ELF: " + str(path))
        native.append({"path": str(path.relative_to(bundle)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        run("elf-" + str(len(native)), ["readelf", "-d", path])
    if not native:
        raise RuntimeError("Missing ELF runtime")
    receipt(nativeFiles=native)
    # The packaged child must resolve its own libraries, not the build prefix.
    del env["LD_LIBRARY_PATH"]
    run("offline-fixture", ["/usr/bin/python3", "-I", ROOT / "inputs/offline-fixture.py", "--", bundle / "gepa-worker"])
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(bundle, DESTINATION, symlinks=True)
    metadata = SOURCE / "qualification-evidence/gepa-package-metadata.json"
    metadata.parent.mkdir(parents=True, exist_ok=True)
    run("manifest", [NODE, SOURCE / "native/gepa/create-manifest.mjs", DESTINATION, "linux-x64", metadata])
    receipt(status="BUILT_STAGED", destination=str(DESTINATION), metadata=str(metadata))
except BaseException as error:
    signal.alarm(0)
    if active is not None and active.poll() is None:
        try:
            os.killpg(active.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            active.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(active.pid, signal.SIGKILL)
            active.wait()
    receipt(status="BLOCKED", error=repr(error), ownedPid=None)
    raise
finally:
    signal.alarm(0)
