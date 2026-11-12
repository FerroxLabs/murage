#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Archive every actual S0 blob, including paths excluded by export-ignore."""
import io
import pathlib
import subprocess
import tarfile

COMMIT = '68ee615aba094f9209bbc482a1a21cd62d024367'
root = pathlib.Path('.afix-evidence')
root.mkdir(exist_ok=True)
manifest = subprocess.check_output(['git', 'ls-tree', '-r', '--full-tree', COMMIT])
(root / 's0-exact.manifest').write_bytes(manifest)
with subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as blobs:
    with tarfile.open(root / 's0-exact.tar', 'w') as archive:
        for line in manifest.decode().splitlines():
            header, name = line.split('\t', 1)
            mode, kind, oid = header.split()
            if kind != 'blob':
                raise RuntimeError('unexpected non-blob: ' + name)
            blobs.stdin.write((oid + '\n').encode())
            blobs.stdin.flush()
            actual_oid, actual_kind, size = blobs.stdout.readline().decode().split()
            assert actual_oid == oid and actual_kind == kind
            body = blobs.stdout.read(int(size))
            assert blobs.stdout.read(1) == b'\n' and len(body) == int(size)
            entry = tarfile.TarInfo(name)
            entry.mode = int(mode[-3:], 8)
            if mode == '120000':
                entry.type = tarfile.SYMTYPE
                entry.linkname = body.decode()
                archive.addfile(entry)
            else:
                entry.size = len(body)
                archive.addfile(entry, io.BytesIO(body))
    blobs.stdin.close()
    assert blobs.wait() == 0
print('Prepared complete S0 blob archive:', COMMIT)
