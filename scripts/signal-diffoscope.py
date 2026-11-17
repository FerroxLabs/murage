#!/usr/bin/env python3
"""Pinned, job-local diffoscope for a failed archive reproduction."""
import hashlib
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import zipfile
import os
from fetch_build_input import fetch_input
INPUTS = [
 ('libarchive.deb','https://deb.debian.org/debian/pool/main/liba/libarchive/libarchive13_3.6.2-1+deb12u4_amd64.deb','ceacf45baae5fdf1ff9b80d9871c17a029c864c928af7620e456454d90c987f3'),
 ('libarchive.whl','https://files.pythonhosted.org/packages/88/3f/ff00c588ebd7eae46a9d6223389f5ae28a3af4b6d975c0f2a6d86b1342b9/libarchive_c-5.3-py3-none-any.whl','651550a6ec39266b78f81414140a1e04776c935e72dfc70f1d7c8e0a3672ffba'),
 ('diffoscope.tar.gz','https://files.pythonhosted.org/packages/01/50/2f7df57b08a3f6045e7a01aa5d6b00c8ccf4dc6603e2d2de02e1ec356c5a/diffoscope-306.tar.gz','2c489aba7334ab0d4a9946ac51fe1b17085621a5476b89950e9c4f1e612cbab3'),
 ('magic.whl','https://files.pythonhosted.org/packages/6c/73/9f872cb81fc5c3bb48f7227872c28975f998f3e7c2b1c16e95e6432bbb90/python_magic-0.4.27-py2.py3-none-any.whl','c212960ad306f700aa0d01e5d7a325d20548ff97eb9920dcd29513174f0294d3'),
]
with tempfile.TemporaryDirectory(prefix='signal-diffoscope-') as d:
    root=pathlib.Path(d)
    for name,url,sha in INPUTS:
        path=root/name
        fetch_input(url, path, sha)
        if hashlib.sha256(path.read_bytes()).hexdigest()!=sha:raise ValueError('diffoscope tool hash mismatch')
        if name.endswith('.deb'):
            subprocess.run(['dpkg-deb','-x',str(path),str(root)],check=True)
        elif name.endswith('.whl'):
            with zipfile.ZipFile(path) as z:z.extractall(root)
        else:
            with tarfile.open(path) as t:
                for member in t.getmembers():
                    if pathlib.PurePosixPath(member.name).is_absolute() or '..' in pathlib.PurePosixPath(member.name).parts or not (member.isfile() or member.isdir()):
                        raise ValueError('Unsafe diffoscope source entry')
                t.extractall(root)
    env={**os.environ,'LIBARCHIVE':str(root/'usr/lib/x86_64-linux-gnu/libarchive.so.13'),'PYTHONPATH':str(root)+os.pathsep+str(root/'diffoscope-306')}
    sys.exit(subprocess.run([sys.executable,'-c','from diffoscope.main import main; main()','--text',*sys.argv[1:]],env=env).returncode)
