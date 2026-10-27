"""Build GEPA on the glibc 2.28 floor, orchestrated by Ubuntu 24.04, without publishing."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

# Kept in sync with scripts/linux-floor.mjs; checked by scripts/linux-floor.test.mjs.
LINUX_FLOOR_IMAGE = "docker.io/library/almalinux:8@sha256:8b469a3a78515e8a18ea8fc727e6a3679e1d0c5ba6f58d5b30be3d0d9b86cffe"
OPENSSL_URL = "https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz"
OPENSSL_SHA256 = "603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"
# Literal recipe. All build inputs live below the single /work bind mount.
FLOOR_BUILD_SCRIPT = r"""#!/bin/bash
set -euo pipefail
case "$MURAGE_BUILD_UID" in ''|*[!0-9]*) exit 2 ;; esac
case "$MURAGE_BUILD_GID" in ''|*[!0-9]*) exit 2 ;; esac
trap 'chown -R "$MURAGE_BUILD_UID:$MURAGE_BUILD_GID" /work' EXIT
export HOME=/work/home TMPDIR=/work/tmp LC_ALL=C.UTF-8
export PYINSTALLER_CONFIG_DIR=/work/cache PIP_CONFIG_FILE=/dev/null PIP_DISABLE_PIP_VERSION_CHECK=1
dnf -y --setopt=install_weak_deps=False --enablerepo=powertools install \
  gcc-8.5.0-29.el8_10.alma.1 make-4.2.1-11.el8 binutils-2.30-128.el8_10 \
  xz-5.2.4-4.el8_6 tar-1.30-13.el8_10 perl-5.26.3-423.el8_10.1 \
  zlib-devel-1.2.11-25.el8 bzip2-devel-1.0.6-28.el8_10 readline-devel-7.0-10.el8 \
  sqlite-devel-3.26.0-21.el8_10 libffi-devel-3.1-24.el8 xz-devel-5.2.4-4.el8_6
rpm -q gcc make binutils xz tar perl zlib-devel bzip2-devel readline-devel sqlite-devel libffi-devel xz-devel glibc glibc-devel > /work/packages.txt
cd /work/source/openssl-3.5.9
./Configure --prefix=/work/openssl --libdir=lib shared no-tests
make -j2
make install_sw
cd /work/source/Python-3.13.15
export LD_LIBRARY_PATH=/work/prefix/lib:/work/openssl/lib
./configure --prefix=/work/prefix --enable-shared --with-ensurepip=install --with-openssl=/work/openssl --with-openssl-rpath=auto
make -j2
make -j2 install
/work/prefix/bin/python3.13 -I -c "import sys,platform,sysconfig,ssl,sqlite3,bz2,lzma,ctypes; print(sys.version); print(platform.libc_ver()); print(ssl.OPENSSL_VERSION); assert sys.version_info[:3]==(3,13,15); assert platform.machine()=='x86_64'; assert not sysconfig.get_config_var('Py_GIL_DISABLED'); assert ssl.OPENSSL_VERSION_INFO[:4]==(3,5,0,9) and ssl.OPENSSL_VERSION.startswith(\"OpenSSL 3.5.9 \")"
/work/prefix/bin/python3.13 -I -m venv /work/venv
/work/venv/bin/python -I -m pip install --no-index --find-links /work/wheelhouse --only-binary=:all: --require-hashes -r /work/inputs/requirements-build.txt
/work/venv/bin/python -I -m PyInstaller --clean --noconfirm --distpath /work/dist --workpath /work/work /work/inputs/gepa-worker.spec
"""


def glibc_version_parts(version):
    return tuple(int(p) for p in version.split(".")) + (0,) * (3 - len(version.split(".")))


def max_glibc_version(output):
    versions = re.findall(r"\bGLIBC_(\d+\.\d+(?:\.\d+)?)\b", output)
    return max(versions, key=glibc_version_parts) if versions else None


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
if any(c in str(ROOT) for c in ",\r\n\x00"):
    raise RuntimeError("Build root cannot contain Docker mount delimiters")
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
         "attempt": 1, "maxSeconds": 2700, "publication": "none",
         "containerImage": LINUX_FLOOR_IMAGE, "glibcFloor": "2.28"}


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
    openssl_archive = ROOT / "inputs/openssl-3.5.9.tar.gz"
    with urllib.request.urlopen(OPENSSL_URL, timeout=60) as src_stream, openssl_archive.open("wb") as out:
        shutil.copyfileobj(src_stream, out)
    openssl_digest = hashlib.sha256(openssl_archive.read_bytes()).hexdigest()
    if openssl_digest != OPENSSL_SHA256:
        raise RuntimeError("OpenSSL source hash mismatch")
    receipt(opensslSourceSha256=openssl_digest)
    with tarfile.open(openssl_archive) as tar:
        tar.extractall(ROOT / "source", filter="data")
    # Download for the built interpreter, not Ubuntu's Python version. Admit only
    # floor-compatible wheel tags; an unavailable hashed wheel is a hard failure.
    platforms = ["manylinux_2_" + str(minor) + "_x86_64" for minor in range(28, 4, -1)]
    platforms += ["manylinux2014_x86_64", "manylinux2010_x86_64", "manylinux1_x86_64"]
    platform_args = [arg for tag in platforms for arg in ("--platform", tag)]
    try:
        run("download-wheels", ["/usr/bin/python3", "-I", "-m", "pip", "download", "--index-url", "https://pypi.org/simple",
                               "--python-version", "3.13", "--implementation", "cp", "--abi", "cp313", *platform_args,
                               "--only-binary=:all:", "--require-hashes", "-r", ROOT / "inputs/requirements-build.txt",
                               "--dest", ROOT / "wheelhouse"])
    except RuntimeError as error:
        raise RuntimeError("Hashed CPython 3.13 wheels for glibc <= 2.28 required; inspect download-wheels.log. Do not loosen hashes or platform tags.") from error
    (ROOT / "build.sh").write_text(FLOOR_BUILD_SCRIPT)
    uid, gid = os.getuid(), os.getgid()
    if any(type(value) is not int or value < 0 for value in (uid, gid)):
        raise RuntimeError("Numeric build UID/GID required")
    run("floor-build", ["docker", "run", "--rm", "--platform", "linux/amd64",
                        "--mount", "type=bind,source=" + str(ROOT) + ",target=/work", "--workdir", "/work",
                        "--env", "MURAGE_BUILD_UID=" + str(uid), "--env", "MURAGE_BUILD_GID=" + str(gid),
                        LINUX_FLOOR_IMAGE, "/bin/bash", "/work/build.sh"])
    receipt(packages=(ROOT / "packages.txt").read_text().splitlines())
    bundle = ROOT / "dist/gepa-worker"
    licenses = bundle / "licenses"
    licenses.mkdir()
    shutil.copyfile(src / "LICENSE", licenses / "Python-LICENSE.txt")
    shutil.copyfile(ROOT / "source/openssl-3.5.9/LICENSE.txt", licenses / "OpenSSL-LICENSE.txt")
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
    over_floor = []
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
        stage = "glibc-" + str(len(native))
        run(stage, ["objdump", "-T", path])
        maximum = max_glibc_version((ROOT / "logs" / (stage + ".log")).read_text())
        native[-1]["glibcMax"] = maximum
        if maximum is not None and glibc_version_parts(maximum) > (2, 28, 0):
            over_floor.append(maximum + " " + str(path.relative_to(bundle)))
    if not native:
        raise RuntimeError("Missing ELF runtime")
    receipt(nativeFiles=native)
    if over_floor:
        raise RuntimeError("GLIBC_FLOOR_EXCEEDED:\n" + "\n".join(over_floor))
    # The packaged child must resolve its own libraries, not the build prefix.
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
    if (ROOT / "packages.txt").is_file():
        state["packages"] = (ROOT / "packages.txt").read_text().splitlines()
    receipt(status="BLOCKED", error=repr(error), ownedPid=None)
    raise
finally:
    signal.alarm(0)
