#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Lane G r7 dry-run defects in the image build scripts: symlink-safe seal, no bytecode in the checkout, early RAM refusal, no stage 1 rerun.
Stdlib only, builds nothing: run as `python3 -I -B build-scripts_test.py`. A fake chattr stands in for the real one (it fails on symlinks
exactly as ext4's does); the real-ext4 proof is a separate run on a builder."""
import os
import pathlib
import re
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
CLOUD_HOME = HERE.parent
REPO = HERE.parents[2]
GUARDS = CLOUD_HOME / "build-guards.sh"

FAKE_CHATTR = """#!/bin/bash
# +i on regular files and directories only; a symlink prints chattr's real error and fails the whole call
rc=0
[[ $1 = +i ]] || exit 2
shift
for f in "$@"; do
  if [[ -L $f ]]; then echo "chattr: Operation not supported while reading flags on $f" >&2; rc=1; else echo "$f" >> "$CHATTR_LOG"; fi
done
exit $rc
"""


def bash(script, env=None):
    return subprocess.run(["bash", "-c", "set -euo pipefail; source %s; %s" % (GUARDS, script)], capture_output=True, text=True,
                          env=dict(os.environ, **(env or {})))


class SealTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        chattr = self.bin / "chattr"
        chattr.write_text(FAKE_CHATTR)
        chattr.chmod(0o755)
        self.log = self.root / "chattr.log"
        self.log.write_text("")
        tree = self.root / "A"
        (tree / "node_modules" / ".pnpm" / "pkg").mkdir(parents=True)
        (tree / "dist").mkdir()
        (tree / "dist" / "index.js").write_text("x")
        (tree / "node_modules" / ".pnpm" / "pkg" / "lib.js").write_text("y")
        os.symlink(".pnpm/pkg", tree / "node_modules" / "pkg")
        os.symlink("../dist/index.js", tree / "node_modules" / "entry")
        self.tree = tree

    def tearDown(self):
        self.tmp.cleanup()

    def env(self):
        return {"PATH": "%s:%s" % (self.bin, os.environ["PATH"]), "CHATTR_LOG": str(self.log)}

    def test_old_recursive_chattr_fails_on_symlinks(self):
        old = subprocess.run(["bash", "-c", "set -e; find %s -exec chattr +i {} +" % self.tree], capture_output=True, text=True, env=dict(os.environ, **self.env()))
        self.assertNotEqual(old.returncode, 0)  # the defect: a link in the batch fails the build

    def test_seal_tree_flags_every_file_and_directory_and_skips_links(self):
        done = bash("seal_tree %s" % self.tree, self.env())
        self.assertEqual(done.returncode, 0, done.stderr)
        flagged = set(self.log.read_text().split())
        expected = {str(p) for p in [self.tree, *self.tree.rglob("*")] if not p.is_symlink()}
        self.assertEqual(expected, flagged)

    def test_seal_tree_takes_several_roots(self):
        other = self.root / "trust"
        other.mkdir()
        (other / "k").write_text("z")
        self.assertEqual(bash("seal_tree %s %s" % (self.tree, other), self.env()).returncode, 0)
        flagged = set(self.log.read_text().split())
        self.assertIn(str(other / "k"), flagged)

    def test_seal_tree_still_fails_when_chattr_fails_on_a_real_file(self):
        (self.bin / "chattr").write_text("#!/bin/bash\nexit 1\n")
        self.assertNotEqual(bash("seal_tree %s" % self.tree, self.env()).returncode, 0)


def load(path, name):
    import importlib.machinery
    import importlib.util
    import sys
    sys.dont_write_bytecode = True
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class VerifySideTest(unittest.TestCase):
    """The seal walk (murage-commands and the launcher's copy) takes links by target text, never by flag, and keeps them in the tree."""

    def test_both_walks_agree_on_link_containment(self):
        for module in (load(CLOUD_HOME / "murage-commands", "mc"), load(CLOUD_HOME / "murage-home-launch.py", "ml")):
            inside = module.links_stay_inside
            self.assertTrue(inside({"node_modules/pkg": ".pnpm/pkg", "node_modules/.pnpm/pkg/up": "../../..", "bin/x": "../dist/index.js"}))
            self.assertFalse(inside({"x": "../outside"}))
            self.assertFalse(inside({"a/b/up": "../..", "top": "a/b/up/.."}))  # escapes only through another link
            self.assertFalse(inside({"a": "b", "b": "a"}))  # loop
            self.assertFalse(inside({"l": "l"}))

    def test_walk_digest_includes_links_and_refuses_an_escape(self):
        for name, path in (("mc2", "murage-commands"), ("ml2", "murage-home-launch.py")):
            module = load(CLOUD_HOME / path, name)
            with tempfile.TemporaryDirectory() as tmp:
                tree = pathlib.Path(tmp) / "A"
                (tree / "d" / "e").mkdir(parents=True)
                (tree / "d" / "f").write_text("x")
                os.symlink("d/f", tree / "link")
                fd = os.open(tree, module.SLOT_OPEN)
                try:
                    self.assertRegex(module.seal_walk_digest(fd, False), r"^[0-9a-f]{64}$")
                finally:
                    os.close(fd)
                os.symlink("../..", tree / "d" / "e" / "up")
                os.symlink("d/e/up/..", tree / "top")
                fd = os.open(tree, module.SLOT_OPEN)
                try:
                    with self.assertRaises(module.LayoutRefused):
                        module.seal_walk_digest(fd, False)
                finally:
                    os.close(fd)


def make_tar(path, entries):
    """entries: (name, kind, data) with kind f (file bytes), d, l (symlink target), h (hardlink target), c (char device), p (fifo)."""
    import io
    import tarfile
    with tarfile.open(path, "w:gz") as tar:
        for name, kind, data in entries:
            info = tarfile.TarInfo(name)
            info.mode = 0o644
            if kind == "f":
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
                continue
            info.type = {"d": tarfile.DIRTYPE, "l": tarfile.SYMTYPE, "h": tarfile.LNKTYPE, "c": tarfile.CHRTYPE, "p": tarfile.FIFOTYPE}[kind]
            if kind in "lh":
                info.linkname = data
            tar.addfile(info)


def listing(base):
    return sorted(str(p.relative_to(base)) for p in pathlib.Path(base).rglob("*"))


class SafeExtractTest(unittest.TestCase):
    """Lane G r10: the whole archive is validated before any create, and every entry is written through directory descriptors."""

    def setUp(self):
        self.mc = load(CLOUD_HOME / "murage-commands", "mc_extract")
        self.tmp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.tmp.name)
        self.slot = self.base / "l1" / "l2" / "l3" / "slot"
        self.slot.parent.mkdir(parents=True)
        self.archive = str(self.base / "r.tar.gz")

    def tearDown(self):
        self.tmp.cleanup()

    def outside(self):
        return [p for p in listing(self.base) if not (p.startswith("l1/l2/l3/slot") or p in ("l1", "l1/l2", "l1/l2/l3", "r.tar.gz"))]

    def test_two_link_chain_creates_nothing_outside_the_slot(self):
        make_tar(self.archive, [("a/b/c/d/up", "l", "../../../.."), ("e", "l", "a/b/c/d/up/../../.."), ("e/pwned", "f", b"x")])
        with self.assertRaises(ValueError):
            self.mc.safe_extract(self.archive, str(self.slot))
        self.assertEqual(self.outside(), [])
        self.assertFalse((self.base / "l1" / "pwned").exists())
        self.assertEqual(listing(self.slot), [])  # refused before the first create

    def test_intermediate_symlink_component_is_refused(self):
        make_tar(self.archive, [("a", "l", "b"), ("b", "d", None), ("a/x", "f", b"x")])
        with self.assertRaises(ValueError):
            self.mc.safe_extract(self.archive, str(self.slot))
        self.assertEqual(listing(self.slot), [])

    def test_a_symlink_already_on_disk_is_never_followed(self):
        # a link planted in the slot before the member is written (the walk itself must refuse it, not only the pre-check)
        make_tar(self.archive, [("evil/pwned", "f", b"x")])
        slot, real_makedirs = self.slot, os.makedirs

        def plant(name, *args, **kwargs):
            real_makedirs(name, *args, **kwargs)
            if str(name) == str(slot):
                os.symlink("../../..", slot / "evil")  # appears after validation, before the first member is written

        os.makedirs = plant
        try:
            with self.assertRaises(ValueError):
                self.mc.safe_extract(self.archive, str(self.slot))
        finally:
            os.makedirs = real_makedirs
        self.assertEqual(self.outside(), [])
        self.assertEqual(listing(self.slot), ["evil"])  # only the planted link; nothing was written through it

    def test_link_loop_and_escape_are_refused(self):
        for entries in ([("a", "l", "b"), ("b", "l", "a")], [("l", "l", "l")], [("x", "l", "../outside")], [("x", "l", "/etc")],
                        [("d/up", "l", "../.."), ("top", "l", "d/up/..")]):
            make_tar(self.archive, entries)
            shutil_rmtree(self.slot)
            with self.assertRaises(ValueError, msg=str(entries)):
                self.mc.safe_extract(self.archive, str(self.slot))
            self.assertEqual(listing(self.slot) if self.slot.exists() else [], [])

    def test_hardlink_device_fifo_absolute_and_dotdot_are_refused(self):
        for entries in ([("f", "f", b"x"), ("h", "h", "f")], [("c", "c", None)], [("p", "p", None)], [("/abs", "f", b"x")],
                        [("a/../b", "f", b"x")], [("../b", "f", b"x")]):
            make_tar(self.archive, entries)
            shutil_rmtree(self.slot)
            with self.assertRaises(ValueError, msg=str(entries)):
                self.mc.safe_extract(self.archive, str(self.slot))
            self.assertEqual(listing(self.slot) if self.slot.exists() else [], [])

    def test_valid_pnpm_tree_installs_and_digest_matches_the_launcher(self):
        make_tar(self.archive, [("node_modules/.pnpm/pkg@1/node_modules/pkg/lib.js", "f", b"y"), ("node_modules/pkg", "l", ".pnpm/pkg@1/node_modules/pkg"),
                                ("node_modules/.pnpm/pkg@1/node_modules/dep", "l", "../../dep@2/node_modules/dep"),
                                ("node_modules/.pnpm/dep@2/node_modules/dep/i.js", "f", b"z"), ("dist/index.js", "f", b"x"), ("empty", "d", None),
                                ("bin/tool", "f", b"#!/bin/sh\n")])
        self.mc.safe_extract(self.archive, str(self.slot))
        self.assertEqual((self.slot / "node_modules" / "pkg" / "lib.js").read_bytes(), b"y")
        self.assertTrue((self.slot / "empty").is_dir())
        launcher = load(CLOUD_HOME / "murage-home-launch.py", "ml_extract")
        digests = []
        for module in (self.mc, launcher):
            fd = os.open(self.slot, module.SLOT_OPEN)
            try:
                digests.append(module.seal_walk_digest(fd, False))
            finally:
                os.close(fd)
        self.assertEqual(digests[0], digests[1])
        self.assertRegex(digests[0], r"^[0-9a-f]{64}$")

    def test_modes_and_owner(self):
        make_tar(self.archive, [("bin/x", "f", b"x"), ("f", "f", b"y"), ("sub", "d", None)])
        self.mc.safe_extract(self.archive, str(self.slot))
        self.assertEqual(os.stat(self.slot / "f").st_mode & 0o777, 0o644)
        self.assertEqual(os.stat(self.slot / "sub").st_mode & 0o777, 0o755)
        if os.geteuid() == 0:
            for p in (self.slot / "f", self.slot / "sub", self.slot / "bin"):
                self.assertEqual((os.stat(p).st_uid, os.stat(p).st_gid), (0, 0))

    def test_a_repeated_member_name_is_refused_whatever_the_type(self):
        for entries in ([("x", "l", "../a"), ("x", "l", "b")], [("x", "l", "b"), ("x", "d", None)], [("x", "d", None), ("x", "l", "b")],
                        [("x", "f", b"1"), ("x", "f", b"2")], [("x", "d", None), ("./x/", "d", None)]):
            make_tar(self.archive, entries)
            shutil_rmtree(self.slot)
            with self.assertRaises(ValueError, msg=str(entries)):
                self.mc.safe_extract(self.archive, str(self.slot))
            self.assertEqual(self.outside(), [])
            self.assertEqual(listing(self.slot) if self.slot.exists() else [], [])

    def test_long_pax_and_gnu_names_are_judged_by_their_full_name(self):
        import io
        import tarfile
        deep = "/".join(["d" * 60] * 6) + "/f.txt"  # well past the 100-byte ustar name field
        for fmt in (tarfile.PAX_FORMAT, tarfile.GNU_FORMAT):
            for name, ok in ((deep, True), ("/".join(["d" * 60] * 6) + "/../../../../../../../../escape.txt", False)):
                with tarfile.open(self.archive, "w:gz", format=fmt) as tar:
                    info = tarfile.TarInfo(name)
                    info.size = 1
                    tar.addfile(info, io.BytesIO(b"x"))
                shutil_rmtree(self.slot)
                if ok:
                    self.mc.safe_extract(self.archive, str(self.slot))
                    self.assertEqual((self.slot / deep).read_bytes(), b"x")
                else:
                    with self.assertRaises(ValueError, msg=str(fmt)):
                        self.mc.safe_extract(self.archive, str(self.slot))
                    self.assertEqual(self.outside(), [])
                    self.assertEqual(listing(self.slot) if self.slot.exists() else [], [])

    def test_one_open_a_swap_after_it_changes_nothing(self):
        make_tar(self.archive, [("good", "f", b"good")])
        handle = self.mc.open_archive(self.archive)
        try:
            os.rename(self.archive, self.archive + ".old")  # the swap: a different archive appears under the same name
            make_tar(self.archive, [("evil", "l", "../../..")])
            self.mc.validate_archive(handle)
            self.mc.extract_validated(handle, str(self.slot))
        finally:
            handle.close()
        self.assertEqual(listing(self.slot), ["good"])
        self.assertEqual(self.outside(), ["r.tar.gz.old"])

    def test_the_digest_covers_the_opened_descriptor_and_a_planted_link_is_not_opened(self):
        import hashlib
        make_tar(self.archive, [("good", "f", b"good")])
        data = pathlib.Path(self.archive).read_bytes()
        self.mc.open_archive(self.archive, (hashlib.sha256(data).hexdigest(), len(data))).close()
        with self.assertRaises(self.mc.LauncherRefused):
            self.mc.open_archive(self.archive, ("0" * 64, len(data)))
        with self.assertRaises(self.mc.LauncherRefused):
            self.mc.open_archive(self.archive, (hashlib.sha256(data).hexdigest(), len(data) + 1))
        os.symlink(self.archive, self.archive + ".ln")
        with self.assertRaises(OSError):
            self.mc.open_archive(self.archive + ".ln")

    def test_abort_install_removes_the_partial_slot_and_nothing_else(self):
        mc, base = self.mc, self.base
        releases, state_dir = base / "releases", base / "state"
        (releases / "A").mkdir(parents=True)
        (releases / "A" / "live.js").write_text("live")
        os.symlink("A", releases / "current")
        (releases / "B" / "dist").mkdir(parents=True)
        (releases / "B" / "dist" / "partial.js").write_text("p")
        os.symlink("dist/partial.js", releases / "B" / "link")
        (state_dir / "manifests").mkdir(parents=True)
        (state_dir / "manifests" / "B.json").write_text("{}")
        (state_dir / "manifests" / "B.sig").write_text("s")
        (state_dir / "manifests" / "A.json").write_text("{}")
        ctx = {"paths": {"releases": str(releases), "update_state": str(state_dir)}}
        state = {"installed": {"slot": "A", "sequence": 1, "revision": "a" * 40},
                 "inflight": {"commandId": "c1", "slot": "B", "phase": "installing"}, "lastResult": None}
        written = []
        mc.write_update_state = lambda c, s: written.append(dict(s))
        mc.freeze = lambda target, frozen: None  # inode flags need CAP_LINUX_IMMUTABLE; the wipe itself is what is under test
        mc.seal_tree = lambda fd, frozen: None
        before = [p for p in listing(base) if not p.startswith("releases/B") and p not in ("state/manifests/B.json", "state/manifests/B.sig")]
        mc.abort_install(ctx, state, "install_failed")
        self.assertFalse((releases / "B").exists())
        self.assertEqual(listing(base), before)
        self.assertEqual((releases / "A" / "live.js").read_text(), "live")
        self.assertIsNone(state["inflight"])
        self.assertEqual(state["lastResult"], {"commandId": "c1", "outcome": "failed", "reason": "install_failed"})
        self.assertEqual(len(written), 1)


def shutil_rmtree(path):
    import shutil
    shutil.rmtree(path, ignore_errors=True)


class FinalizeRepublishTest(unittest.TestCase):
    """cloud-home-release.sh finalize re-hashes the published archive after the copy; needs OpenSSL 3 (Ed25519 raw sign)."""

    def test_swap_of_the_published_archive_after_the_copy_fails(self):
        import hashlib
        import json
        import shutil
        probe = subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519"], capture_output=True)
        if probe.returncode != 0:
            self.skipTest("no Ed25519 in this openssl")
        mc = load(CLOUD_HOME / "murage-commands", "mc_final")
        installer = load(CLOUD_HOME / "install-launchers.py", "il_final")
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            tree = tmp / "tree"
            for rel in ("launchers.txt", "launcher-abi", "murage-turn-launch.py", "murage-browser-namespace.py", "murage-browser-network.py"):
                (tree / "deploy" / "cloud-home").mkdir(parents=True, exist_ok=True)
                shutil.copy(CLOUD_HOME / rel, tree / "deploy" / "cloud-home" / rel)
            (tree / "dist-server").mkdir()
            (tree / "dist-server" / "index.js").write_text("i")
            (tree / "dist-server" / "cloud-home-supervisor.js").write_text("s")
            entries = sorted(str(p.relative_to(tree)) for p in tree.rglob("*") if p.is_file())
            archive = tmp / "out" / "x86_64" / "murage-cloud-home-5.tar.gz"
            archive.parent.mkdir(parents=True)
            import tarfile
            with tarfile.open(archive, "w:gz") as tar:
                for rel in entries:
                    tar.add(tree / rel, arcname=rel)
            check = tmp / "check"
            mc.safe_extract(str(archive), str(check))
            installer.apply_modes(str(check), installer.plan(str(check / "deploy" / "cloud-home")))
            fd = os.open(check, mc.SLOT_OPEN)
            try:
                tree_sha = mc.seal_walk_digest(fd, False)
            finally:
                os.close(fd)
            data = archive.read_bytes()
            revision = "a" * 40
            manifest = json.dumps({"format": "murage-cloud-home-release-v3", "sequence": 5, "revision": revision, "arch": "x86_64", "archive": archive.name,
                                   "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "treeSha256": tree_sha,
                                   "launcherAbi": (CLOUD_HOME / "launcher-abi").read_text().strip()}).encode()
            (archive.parent / "manifest.json").write_bytes(manifest)
            private, public = tmp / "k.pem", tmp / "k.pub"
            subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(private)], check=True, capture_output=True)
            subprocess.run(["openssl", "pkey", "-in", str(private), "-pubout", "-out", str(public)], check=True, capture_output=True)
            subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", str(private), "-rawin", "-in", str(archive.parent / "manifest.json"),
                            "-out", str(archive.parent / "manifest.json.sig")], check=True, capture_output=True)
            script = REPO / "scripts" / "cloud-home-release.sh"
            args = ["bash", str(script), "finalize", "x86_64", revision, str(tmp / "out"), str(public)]
            clean = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(clean.returncode, 0, clean.stdout + clean.stderr)
            # a cp shim that swaps the published archive right after the copy
            shim = tmp / "bin"
            shim.mkdir()
            real = shutil.which("cp")
            (shim / "cp").write_text('#!/bin/bash\n%s "$@" || exit $?\nprintf X >> "%s"\n' % (real, archive))
            (shim / "cp").chmod(0o755)
            swapped = subprocess.run(args, capture_output=True, text=True, env=dict(os.environ, PATH="%s:%s" % (shim, os.environ["PATH"])))
            self.assertNotEqual(swapped.returncode, 0, swapped.stdout)


class BytecodeTest(unittest.TestCase):
    def test_every_python_in_the_build_scripts_is_no_bytecode(self):
        for path in (CLOUD_HOME / "build-image.sh", REPO / "scripts" / "cloud-home-release.sh"):
            text = path.read_text()
            self.assertIn("export PYTHONDONTWRITEBYTECODE=1", text)
            for number, line in enumerate(text.splitlines(), 1):
                if line.lstrip().startswith(("#", "apt-get")):
                    continue
                for match in re.finditer(r"python3(?![-\w])(?P<rest>[^\n]*)", line):
                    self.assertRegex(match.group("rest"), r"^ (-I -B|-B)\b", "%s:%d python3 without -B: %s" % (path.name, number, line.strip()))

    def test_stage_helper_leaves_no_pycache_in_the_checkout(self):
        def pycaches():
            return sorted(str(p) for p in REPO.rglob("__pycache__") if "node_modules" not in p.parts and ".git" not in p.parts)
        before = pycaches()
        with tempfile.TemporaryDirectory() as tmp:
            tree = pathlib.Path(tmp) / "A"
            tree.mkdir()
            (tree / "f").write_text("x")
            hostid = pathlib.Path(tmp) / "machine-id"
            hostid.write_text("abc\n")
            marker = pathlib.Path(tmp) / "m" / "stage1.json"
            env = {k: v for k, v in os.environ.items() if k != "PYTHONDONTWRITEBYTECODE"}
            # no -B here: only the helper's own sys.dont_write_bytecode may keep the checkout clean
            args = ["python3", "-I", str(CLOUD_HOME / "image-stage.py")]
            rev = "a" * 40
            for action in ("mark", "check"):
                run = subprocess.run(args + [action, str(CLOUD_HOME / "murage-commands"), str(tree), rev, str(marker), str(hostid)], capture_output=True, text=True, env=env)
                self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(pycaches(), before)


class GuardTest(unittest.TestCase):
    def test_ram_below_minimum_fails_naming_cx33_and_cax21(self):
        low = bash("require_builder_ram 3819")
        self.assertNotEqual(low.returncode, 0)
        self.assertIn("cx33", low.stderr)
        self.assertIn("cax21", low.stderr)
        self.assertIn("3819 MB", low.stderr)
        self.assertNotEqual(bash("require_builder_ram 7399").returncode, 0)
        self.assertEqual(bash("require_builder_ram 7400").returncode, 0)
        self.assertEqual(bash("require_builder_ram 7700").returncode, 0)

    def test_build_image_calls_the_guards_before_any_install(self):
        text = (CLOUD_HOME / "build-image.sh").read_text()
        self.assertLess(text.index("require_fresh_builder /opt/murage-releases /opt/murage"), text.index("ln -s A /opt/murage-releases/current"))
        self.assertLess(text.index("require_builder_ram \"$build_ram_mb\""), text.index("apt-get -S"))
        self.assertNotIn("chattr -R", text)

    def test_stage_1_refuses_a_host_with_a_previous_partial_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            releases, link = pathlib.Path(tmp) / "murage-releases", pathlib.Path(tmp) / "murage"
            self.assertEqual(bash("require_fresh_builder %s %s" % (releases, link)).returncode, 0)  # nothing there
            releases.mkdir()
            self.assertEqual(bash("require_fresh_builder %s %s" % (releases, link)).returncode, 0)  # an empty directory is fresh
            (releases / "A").mkdir()
            refused = bash("require_fresh_builder %s %s" % (releases, link))
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("fresh builder required", refused.stderr)
            (releases / "A").rmdir()
            os.symlink("murage-releases/current", link)  # a dangling link counts as a leftover
            self.assertNotEqual(bash("require_fresh_builder %s %s" % (releases, link)).returncode, 0)


if __name__ == "__main__":
    unittest.main()
