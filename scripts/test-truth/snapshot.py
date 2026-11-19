#!/usr/bin/env python3
"""Create complete comparison sources, including export-ignored fixtures and Git.

Release/customer archives intentionally omit development paths. Never use those
archives as test inputs. This checkout is private and exists only while packed.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import tempfile


def snapshot(repo, revision, output, base=None):
    repo = pathlib.Path(repo).resolve()
    def resolve(ref):
        return subprocess.check_output(["git", "-C", str(repo), "rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], stderr=subprocess.PIPE).decode().strip()
    revision = resolve(revision)
    base = resolve(base) if base else None
    output = pathlib.Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    # The container dispatcher syncs the checkout recursively. Keep volatile
    # checkout scratch outside that tree so its cleanup cannot race rsync.
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="truth-snapshot-"))
    root = scratch / "source"
    root.mkdir()
    config = scratch / "empty-git-config"
    config.write_text("")
    import os
    env = {**os.environ, "GIT_CONFIG_GLOBAL": str(config), "GIT_CONFIG_SYSTEM": str(config)}

    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], env=env, stderr=subprocess.PIPE)

    try:
        git("init", "-q")
        # file:// also supports bare repositories; fetching into our private Git
        # copies objects instead of retaining another checkout's .git pointer.
        common = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "--path-format=absolute", "--git-common-dir"], stderr=subprocess.PIPE).decode().strip()
        source = pathlib.Path(common).resolve().as_uri()
        for ref in dict.fromkeys([r for r in [base, revision] if r]):
            git("fetch", "--depth=1", source, ref)
        git("checkout", "-q", "--detach", revision)
        sha = git("rev-parse", "HEAD").decode().strip()
        entries = {}
        for record in git("ls-tree", "-rz", "HEAD").split(b"\0"):
            if not record:
                continue
            metadata, path = record.split(b"\t", 1)
            mode, kind, oid = metadata.decode().split()
            name = path.decode()
            source_path = root / name
            if kind == "commit":
                source_path.mkdir(parents=True, exist_ok=True)
                entries[name] = {"kind": "gitlink", "oid": oid, "mode": mode}
            elif source_path.is_symlink():
                entries[name] = {"kind": "symlink", "target": os.readlink(source_path), "mode": mode}
            else:
                entries[name] = {"kind": "file", "sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(), "mode": mode}
        with tarfile.open(output, "w:gz", compresslevel=1) as archive:
            for name in entries:
                archive.add(root / name, arcname=name, recursive=False)
            archive.add(root / ".git", arcname=".git")
        manifest = {"revision": sha, "files": entries}
        output.with_name(output.name.removesuffix(".tar.gz") + "-manifest.json").write_text(json.dumps(manifest, sort_keys=True) + "\n")
        print(json.dumps({"revision": sha, "tracked": len(entries), "archive": str(output)}))
        return manifest
    finally:
        shutil.rmtree(scratch)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--base")
    options = parser.parse_args()
    snapshot(options.repo, options.revision, options.output, options.base)
