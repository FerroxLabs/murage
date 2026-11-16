#!/usr/bin/python3 -I
# SPDX-License-Identifier: AGPL-3.0-or-later
"""The one launcher-list step (Lane G r3). Used by build-image.sh (command line: install the three root launchers into
/usr/local/libexec as regular files, once, at image build) and by murage-commands update_software (imported from
/usr/local/libexec/murage-install-launchers, so a release can never replace the code that reads its list).

  install-launchers.py SOURCE_DIR DEST_DIR     read SOURCE_DIR/launchers.txt, copy each launcher into DEST_DIR (temp + rename)

The launchers are image-pinned: an update never installs, links or moves anything under /usr/local/libexec. For a staged release
the module offers plan (the list is valid, the floor of three present, every source a plain file), apply_modes (the manifest modes
on the sources inside the release tree) and check_abi (the release's `abi` token equals the image's; otherwise the update is refused
with launcher_abi_mismatch and the home is re-imaged). Nothing here reads the network or runs a shell."""
import os
import re
import stat
import sys

MANIFEST = "launchers.txt"
REQUIRED = ("murage-turn-launch", "murage-browser-namespace", "murage-browser-network")
SOURCE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}")
# The EXACT set this step may ever write into /usr/local/libexec, name -> source file. A signed manifest naming anything else
# (murage-install-launchers, murage-egress-proxy, murage-home-start, ...) is refused, never installed.
ALLOWED = {"murage-turn-launch": "murage-turn-launch.py", "murage-browser-namespace": "murage-browser-namespace.py",
           "murage-browser-network": "murage-browser-network.py"}
MODE = re.compile(r"0[0-7]{3}")
ABI = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
MAX_BYTES = 4 << 20


class LauncherError(Exception):
    """code: a fixed lowercase token, the only detail that is ever logged."""
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def parse(text):
    """(abi, entries): the first non-comment line is `abi <token>` (the launcher ABI the sources implement); every other line is
    `source installed-name mode`, exactly from the allowlist, no set-id, no group/world write, executable, no repeat."""
    entries, seen, abi = [], set(), None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if abi is None:
            if len(parts) != 2 or parts[0] != "abi" or not ABI.fullmatch(parts[1]):
                raise LauncherError("launcher_manifest_invalid")
            abi = parts[1]
            continue
        if len(parts) != 3 or not SOURCE.fullmatch(parts[0]) or not MODE.fullmatch(parts[2]):
            raise LauncherError("launcher_manifest_invalid")
        if ALLOWED.get(parts[1]) != parts[0]:
            raise LauncherError("launcher_not_allowed")
        mode = int(parts[2], 8)
        if mode & 0o7022 or not mode & 0o100 or parts[1] in seen:
            raise LauncherError("launcher_manifest_invalid")
        seen.add(parts[1])
        entries.append((parts[0], parts[1], mode))
    if abi is None:
        raise LauncherError("launcher_manifest_invalid")
    return abi, entries


def _read(source_dir):
    try:
        fd = os.open(os.path.join(source_dir, MANIFEST), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as handle:
            raw = handle.read(65537)
    except OSError:
        raise LauncherError("launchers_missing") from None
    if len(raw) > 65536:
        raise LauncherError("launcher_manifest_invalid")
    try:
        return parse(raw.decode("utf-8"))
    except UnicodeDecodeError:
        raise LauncherError("launcher_manifest_invalid") from None


def plan(source_dir):
    """The launchers a release carries: manifest valid, the required floor present, every source a plain file (never a link). A release
    must still ship the sources the image was built from; what the image pins is never changed by an update."""
    _abi, entries = _read(source_dir)
    if {name for _src, name, _mode in entries} != set(ALLOWED):
        raise LauncherError("launchers_missing")
    for source, _name, _mode in entries:
        try:
            info = os.lstat(os.path.join(source_dir, source))
        except OSError:
            raise LauncherError("launchers_missing") from None
        if not stat.S_ISREG(info.st_mode) or info.st_size == 0 or info.st_size > MAX_BYTES:
            raise LauncherError("launchers_missing")
    return entries


def abi(source_dir):
    """The `abi <token>` line of launchers.txt."""
    return _read(source_dir)[0]


def check_abi(release_tree, trust_abi):
    """What the updater calls at idle and at install: the release's launcher ABI must be the image's (launcher_abi_mismatch otherwise)."""
    if abi(os.path.join(release_tree, "deploy", "cloud-home")) != trust_abi:
        raise LauncherError("launcher_abi_mismatch")


def apply_modes(tree, entries):
    """The manifest mode on each launcher source inside the release tree (O_NOFOLLOW open, fchmod): the release's copies document what
    the image pins; they are never installed anywhere."""
    for source, _name, mode in entries:
        fd = os.open(os.path.join(tree, "deploy", "cloud-home", source), os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fchmod(fd, mode)
        finally:
            os.close(fd)


def _fsync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def install(source_dir, dest_dir):
    """build-image.sh only: each launcher copied beside its destination (temp file, fsynced, root:root with its mode) and renamed into
    place, as a regular file. build-image.sh then sets FS_IMMUTABLE_FL on each and on the directory."""
    entries = plan(source_dir)
    os.makedirs(dest_dir, mode=0o755, exist_ok=True)
    for source, name, mode in entries:
        src = os.open(os.path.join(source_dir, source), os.O_RDONLY | os.O_NOFOLLOW)
        try:
            data = os.read(src, MAX_BYTES + 1)
        finally:
            os.close(src)
        if not data or len(data) > MAX_BYTES:
            raise LauncherError("launchers_missing")
        temporary = os.path.join(dest_dir, "." + name + ".new")
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            if os.geteuid() == 0:
                os.fchown(out.fileno(), 0, 0)
            os.fchmod(out.fileno(), mode)
            os.fsync(out.fileno())
        os.replace(temporary, os.path.join(dest_dir, name))
    _fsync_dir(dest_dir)
    return [name for _s, name, _m in entries]


def main(argv):
    if len(argv) != 3:
        print("Usage: install-launchers.py SOURCE_DIR DEST_DIR", file=sys.stderr)
        return 2
    try:
        names = install(argv[1], argv[2])
    except LauncherError as error:
        print("Launcher install refused: " + error.code, file=sys.stderr)
        return 1
    print("Installed launchers: " + " ".join(names))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
