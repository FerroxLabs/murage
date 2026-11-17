#!/usr/bin/env python3
"""Expose the effective Java-25 classpath to jdeps without JPMS descriptors.

The launcher uses -jar/classpath, not a module path. jdeps treats jar arguments
with module-info as modules and fails resolving optional third-party modules
before --ignore-missing-deps can take effect. This projection preserves every
class from all 51 jars (including Java-25 multi-release overlays), omitting only
the JPMS descriptors which the production classpath launcher also ignores.
"""
import pathlib
import sys
import zipfile
source, destination = map(pathlib.Path, sys.argv[1:])
destination.mkdir()
jars = sorted(source.glob('*.jar'))
if len(jars) != 51:
    raise ValueError('Expected all 51 jars for jdeps')
for jar in jars:
    with zipfile.ZipFile(jar) as z:
        multi = b'Multi-Release: true' in z.read('META-INF/MANIFEST.MF') if 'META-INF/MANIFEST.MF' in z.namelist() else False
        classes = {}
        for name in z.namelist():
            if not name.endswith('.class'):
                continue
            version, path = 0, name
            if name.startswith('META-INF/versions/'):
                if not multi:
                    continue
                _, _, v, path = name.split('/', 3)
                version = int(v)
                if version > 25:
                    continue
            if path == 'module-info.class':
                continue
            if path.startswith('/') or '..' in pathlib.PurePosixPath(path).parts:
                raise ValueError('Unsafe class entry')
            if path not in classes or classes[path][0] < version:
                classes[path] = version, name
        for path, (_, entry) in classes.items():
            dest = destination / path
            data = z.read(entry)
            if dest.exists() and dest.read_bytes() != data:
                raise ValueError('Conflicting class: ' + path)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
