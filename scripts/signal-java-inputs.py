#!/usr/bin/env python3
"""Download/extract only immutable, SHA256-pinned Temurin archives on Linux."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import zipfile
from fetch_build_input import fetch_input

FINGERPRINT = "3B04D753C9050D9A5D343F39843C48A565F8F04B"

def authenticate(archive, pin, checksum, signature, gpg, run=subprocess.run):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != pin["sha256"]:
        raise ValueError("Temurin archive hash mismatch")
    published = checksum.read_text().split()[0]
    if not re.fullmatch(r"[0-9a-f]{64}", published) or published != pin["sha256"]:
        raise ValueError("Published Adoptium checksum mismatch")
    status = run(gpg + ["--status-fd", "1", "--verify", str(signature), str(archive)],
                 check=True, capture_output=True, text=True).stdout
    valid = [line.split() for line in status.splitlines() if line.startswith("[GNUPG:] VALIDSIG ")]
    if len(valid) != 1 or len(valid[0]) < 3 or FINGERPRINT not in (valid[0][2], valid[0][-1]):
        raise ValueError("Invalid Adoptium signer")

def main():
    pins = json.loads(pathlib.Path(__file__).with_name("signal-java-inputs.json").read_text())
    root = pathlib.Path(sys.argv[1]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    # https://adoptium.net/installation/gpg-verification
    gnupg = root / "gnupg"
    gnupg.mkdir(mode=0o700)
    key = root / "adoptium.asc"
    key_bytes = pathlib.Path(__file__).with_name("adoptium-signing-key.asc").read_bytes()
    if hashlib.sha256(key_bytes).hexdigest() != "52542b963fb4c1ee5607e3da4a794727e9ba3d3266988d7dff3a9d3425e88c67":
        raise ValueError("Adoptium signing key sha256 mismatch")
    key.write_bytes(key_bytes)
    gpg = ["gpg", "--homedir", str(gnupg), "--batch", "--no-auto-key-retrieve"]
    subprocess.run(gpg + ["--import", str(key)], check=True, capture_output=True)
    keys = subprocess.run(gpg + ["--with-colons", "--fingerprint"], check=True, capture_output=True, text=True).stdout
    if FINGERPRINT not in [line.split(":")[9] for line in keys.splitlines() if line.startswith("fpr:")]:
        raise ValueError("Adoptium signing key fingerprint mismatch")
    for target, pin in pins.items():
        archive = root / (target + (".zip" if pin["url"].endswith(".zip") else ".tar.gz"))
        if not archive.exists():
            fetch_input(pin["url"], archive, pin["sha256"])
        if hashlib.sha256(archive.read_bytes()).hexdigest() != pin["sha256"]:
            raise ValueError(f"{target}: Temurin archive hash mismatch")
        checksum, signature = pathlib.Path(str(archive) + ".sha256.txt"), pathlib.Path(str(archive) + ".sig")
        for path, suffix in [(checksum, ".sha256.txt"), (signature, ".sig")]:
            fetch_input(pin["url"] + suffix, path)
        authenticate(archive, pin, checksum, signature, gpg)
        published = pin["sha256"]
        (root / (target + ".authentication.json")).write_text(json.dumps({"sha256": published, "fingerprint": FINGERPRINT}))
        dest = root / target
        if dest.exists():
            raise ValueError(f"Refusing existing extraction: {dest}")
        dest.mkdir()
        if archive.suffix == ".zip":
            with zipfile.ZipFile(archive) as z:
                for name in z.namelist():
                    p = pathlib.PurePosixPath(name)
                    if p.is_absolute() or ".." in p.parts:
                        raise ValueError("Unsafe Java ZIP entry")
                z.extractall(dest)
        else:
            with tarfile.open(archive) as t:
                for member in t.getmembers():
                    name = pathlib.PurePosixPath(member.name)
                    if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                        raise ValueError("Unsafe Java tar entry")
                    if member.issym() or member.islnk():
                        parent = name.parent if member.issym() else pathlib.PurePosixPath(".")
                        link_target = pathlib.PurePosixPath(os.path.normpath(str(parent / member.linkname)))
                        if link_target.is_absolute() or ".." in link_target.parts:
                            raise ValueError("Java tar link escapes image")
                t.extractall(dest)
        homes = list(dest.rglob("release"))
        if len(homes) != 1:
            raise ValueError(f"{target}: ambiguous Java home")
        (root / (target + ".home")).write_text(str(homes[0].parent) + "\n")
        print(target, pin["build"], pin["sha256"], flush=True)

if __name__ == "__main__":
    main()
