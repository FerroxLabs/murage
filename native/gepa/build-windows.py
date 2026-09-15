"""Build an unsigned Windows GEPA tree; CI signs it before manifest creation."""
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import sysconfig
import time
import zipfile

SOURCE = pathlib.Path(__file__).resolve().parents[2]
if sys.platform != "win32" or platform.machine().lower() != "amd64":
    raise RuntimeError("Native Windows AMD64 required")
if sys.version_info[:3] != (3, 13, 15) or sysconfig.get_config_var("Py_GIL_DISABLED"):
    raise RuntimeError("Standard GIL CPython 3.13.15 required")
if len(sys.argv) != 2:
    raise RuntimeError("Usage: build-windows.py ABSOLUTE_NEW_BUILD_ROOT")
ROOT = pathlib.Path(sys.argv[1])
DESTINATION = SOURCE / "dist-native/gepa/win32-x64"
if not ROOT.is_absolute() or ROOT.exists() or DESTINATION.exists():
    raise RuntimeError("Fresh build root and absent GEPA stage required")
ROOT.mkdir(parents=True)
deadline = time.monotonic() + 1800
for directory in ("home", "tmp", "cache", "wheelhouse", "logs", "work", "dist"):
    (ROOT / directory).mkdir()
environment = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "COMSPEC") if key in os.environ}
environment.update(HOME=str(ROOT / "home"), USERPROFILE=str(ROOT / "home"),
                   APPDATA=str(ROOT / "home/AppData/Roaming"), LOCALAPPDATA=str(ROOT / "home/AppData/Local"),
                   TMP=str(ROOT / "tmp"), TEMP=str(ROOT / "tmp"),
                   PATH=os.pathsep.join([str(pathlib.Path(sys.executable).parent), str(pathlib.Path(os.environ["SYSTEMROOT"]) / "System32")]),
                   PYINSTALLER_CONFIG_DIR=str(ROOT / "cache"), PIP_CONFIG_FILE=os.devnull,
                   PIP_DISABLE_PIP_VERSION_CHECK="1")

def run(name, args, cwd=SOURCE):
    with (ROOT / "logs" / (name + ".log")).open("wb") as log:
        process = subprocess.Popen([str(arg) for arg in args], cwd=cwd, env=environment,
                                   stdout=log, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        try:
            code = process.wait(timeout=max(1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], env=environment,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            process.wait(timeout=20)
            raise RuntimeError("GEPA producer 30-minute limit reached")
    if code:
        raise RuntimeError(name + " failed; see task-owned log")

head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SOURCE, text=True).strip()
subprocess.run(["git", "diff", "--exit-code", head, "--", "native/gepa"], cwd=SOURCE, check=True)
names = ["gepa-worker.py", "gepa-worker.spec", "requirements-build.txt", "requirements-runtime.txt", "offline-fixture.py"]
identity = {"sourceSha": head, "pythonVersion": platform.python_version(), "architecture": platform.machine(),
            "pythonExecutableSha256": hashlib.sha256(pathlib.Path(sys.executable).read_bytes()).hexdigest(),
            "inputs": {name: hashlib.sha256((SOURCE / "native/gepa" / name).read_bytes()).hexdigest() for name in names}}
(ROOT / "source-identity.json").write_text(json.dumps(identity, indent=2) + "\n")
run("venv", [sys.executable, "-I", "-m", "venv", ROOT / "venv"])
python = ROOT / "venv/Scripts/python.exe"
run("download", [python, "-I", "-m", "pip", "download", "--index-url", "https://pypi.org/simple",
                 "--only-binary=:all:", "--require-hashes", "--dest", ROOT / "wheelhouse",
                 "-r", SOURCE / "native/gepa/requirements-build.txt"])
run("install", [python, "-I", "-m", "pip", "install", "--no-index", "--find-links", ROOT / "wheelhouse",
                "--only-binary=:all:", "--require-hashes", "-r", SOURCE / "native/gepa/requirements-build.txt"])
run("package", [python, "-I", "-m", "PyInstaller", "--clean", "--noconfirm", "--distpath", ROOT / "dist",
                "--workpath", ROOT / "work", SOURCE / "native/gepa/gepa-worker.spec"])
bundle = ROOT / "dist/gepa-worker"
licenses = bundle / "licenses"
licenses.mkdir()
python_license = pathlib.Path(sys.base_prefix) / "LICENSE.txt"
if not python_license.is_file() or not python_license.stat().st_size:
    raise RuntimeError("Actual Python distribution license missing")
shutil.copyfile(python_license, licenses / "Python-LICENSE.txt")
notices = [python_license.read_text(encoding="utf-8")]
gepa_license = None
wheel_hashes = {}
for wheel in sorted((ROOT / "wheelhouse").glob("*.whl")):
    wheel_hashes[wheel.name] = hashlib.sha256(wheel.read_bytes()).hexdigest()
    with zipfile.ZipFile(wheel) as archive:
        entries = [name for name in archive.namelist() if ".dist-info/" in name and not name.endswith("/")
                   and pathlib.PurePosixPath(name).name.lower().startswith(("license", "copying", "notice"))]
        if not entries:
            raise RuntimeError("Wheel license missing: " + wheel.name)
        for name in entries:
            text = archive.read(name).decode("utf-8")
            if not text.strip():
                raise RuntimeError("Empty license")
            notices.append("\n===== " + wheel.name + " / " + name + " =====\n" + text)
            if wheel.name.startswith("gepa-0.1.4-") and pathlib.PurePosixPath(name).name.lower().startswith("license"):
                gepa_license = text
if not gepa_license:
    raise RuntimeError("GEPA license missing")
(licenses / "GEPA-LICENSE.txt").write_text(gepa_license, encoding="utf-8")
(licenses / "THIRD-PARTY-NOTICES.txt").write_text("\n".join(notices), encoding="utf-8")
DESTINATION.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(bundle, DESTINATION)
evidence = SOURCE / "qualification-evidence"
evidence.mkdir(exist_ok=True)
(evidence / "gepa-windows-build.json").write_text(json.dumps({**identity, "wheelHashes": wheel_hashes,
    "stage": str(DESTINATION), "signed": False}, indent=2) + "\n")
print("GEPA Windows stage built; pre-manifest signing and runtime qualification still required.")
