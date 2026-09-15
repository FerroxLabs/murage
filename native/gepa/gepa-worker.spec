# Production-only PyInstaller recipe. This file is executed by the build tool.
import importlib.metadata
import platform
import sys
import sysconfig
from pathlib import Path
from PyInstaller.utils.hooks import copy_metadata

if sys.version_info[:3] != (3, 13, 15) or sys.implementation.name != "cpython" or sysconfig.get_config_var("Py_GIL_DISABLED"):
    raise RuntimeError("Production GEPA worker requires standard GIL CPython 3.13.15")
if importlib.metadata.version("pyinstaller") != "6.22.3" or importlib.metadata.version("gepa") != "0.1.4":
    raise RuntimeError("GEPA/PyInstaller production pin mismatch")
machine = platform.machine().lower()
target = {( "darwin", "arm64"): "darwin-arm64", ("darwin", "x86_64"): "darwin-x64",
          ("win32", "amd64"): "win32-x64", ("linux", "x86_64"): "linux-x64"}.get((sys.platform, machine))
if target is None:
    raise RuntimeError("Unsupported GEPA desktop target")
root = Path(SPECPATH)
a = Analysis([str(root / "gepa-worker.py")], pathex=[], binaries=[],
             datas=copy_metadata("gepa"), hiddenimports=[],
             excludes=["litellm", "datasets", "wandb", "mlflow", "cloudpickle", "tqdm"],
             hookspath=[], runtime_hooks=[], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="gepa-worker", debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=True,
          disable_windowed_traceback=False, argv_emulation=False,
          target_arch="arm64" if target == "darwin-arm64" else "x86_64" if target == "darwin-x64" else None,
          codesign_identity=None, entitlements_file=None)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="gepa-worker")
